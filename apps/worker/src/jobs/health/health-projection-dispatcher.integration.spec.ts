import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, test } from "node:test";

import { PrismaClient } from "@prisma/client";
import type { Prisma } from "@prisma/client";

import { HealthProjectionDispatcher } from "./health-projection-dispatcher";

const database = new PrismaClient();
const dispatcher = new HealthProjectionDispatcher(database, { leaseSeconds: 30 });

before(async () => {
  await database.$connect();
});

afterEach(async () => {
  await database.$executeRawUnsafe(`
    TRUNCATE TABLE
      consumer_inbox,
      domain_outbox_consent_requirements,
      domain_outbox,
      daily_health_fact_revisions,
      health_sync_runs,
      profile_events,
      consent_records,
      users
    RESTART IDENTITY CASCADE
  `);
});

after(async () => {
  await database.$disconnect();
});

async function message(granted = true) {
  const user = await database.user.create({ data: { consentEpoch: 1 } });
  await database.consentRecord.create({
    data: {
      userId: user.id,
      consentType: "health_processing",
      documentVersion: "health-v1",
      granted,
      epoch: 1,
      correlationId: randomUUID(),
      requestHash: randomUUID(),
      source: "synthetic",
    },
  });
  const run = await database.healthSyncRun.create({
    data: {
      userId: user.id,
      deviceId: "synthetic-health-device",
      anchorEpoch: 1,
      idempotencyKey: randomUUID(),
      requestHash: randomUUID(),
      timezone: "Asia/Shanghai",
      consentEpoch: 1,
      correlationId: randomUUID(),
      status: "completed",
      completedAt: new Date(),
    },
  });
  const revision = await database.dailyHealthFactRevision.create({
    data: {
      userId: user.id,
      localDate: new Date("2026-07-10T00:00:00.000Z"),
      metric: "steps",
      canonicalValueJson: { value: 8000 },
      coverage: 1,
      sourceVectorJson: [{ source_id: "synthetic-watch", contribution: 1 }],
      inputHash: randomUUID(),
      healthSyncRunId: run.id,
      serverSequence: run.serverSequence,
    },
  });
  const outbox = await database.domainOutbox.create({
    data: {
      userId: user.id,
      aggregateId: run.id,
      eventType: "health.facts.accepted",
      idempotencyKey: randomUUID(),
      payload: {
        sync_run_id: run.id,
        revision_ids: [revision.id],
        server_sequence: run.serverSequence.toString(),
      },
      consentRequirements: {
        create: { purpose: "health_processing", grantEpoch: 1 },
      },
    },
  });
  return { user, outbox, revision, run };
}

test("claims with fencing and creates one inbox/profile event across retry", async () => {
  const { outbox } = await message();
  const firstLease = await dispatcher.claim(outbox.id);
  await dispatcher.process(outbox.id, firstLease.leaseToken ?? "missing");
  await dispatcher.process(outbox.id, firstLease.leaseToken ?? "missing");

  assert.equal(await database.consumerInbox.count(), 1);
  assert.equal(await database.profileEvent.count(), 1);
  assert.equal(await database.domainOutbox.count({
    where: { eventType: "profile.event.appended" },
  }), 1);
  const event = await database.profileEvent.findFirstOrThrow();
  const facts = (event.payload as Prisma.JsonObject).facts;
  assert.ok(Array.isArray(facts));
  const firstFact = facts[0] as Prisma.JsonObject;
  assert.equal(typeof firstFact.revision_id, "string");
  assert.equal((firstFact.revision_id as string).length, 36);
  assert.equal(
    (await database.domainOutbox.findUniqueOrThrow({ where: { id: outbox.id } })).status,
    "sent",
  );
});

test("rejects stale leases and suppresses work after consent withdrawal", async () => {
  const { user, outbox } = await message();
  const lease = await dispatcher.claim(outbox.id);
  await database.consentRecord.create({
    data: {
      userId: user.id,
      consentType: "health_processing",
      documentVersion: "health-v1",
      granted: false,
      epoch: 2,
      correlationId: randomUUID(),
      requestHash: randomUUID(),
      source: "synthetic",
    },
  });
  await database.user.update({ where: { id: user.id }, data: { consentEpoch: 2 } });

  await dispatcher.process(outbox.id, lease.leaseToken ?? "missing");
  assert.equal(await database.profileEvent.count(), 0);
  assert.equal(
    (await database.domainOutbox.findUniqueOrThrow({ where: { id: outbox.id } })).status,
    "suppressed",
  );
  await assert.rejects(dispatcher.process(outbox.id, "stale-token"));
});

test("reclaims an expired lease and fences the old worker", async () => {
  const { outbox } = await message();
  const first = await dispatcher.claim(outbox.id);
  await database.domainOutbox.update({
    where: { id: outbox.id },
    data: { leaseUntil: new Date(Date.now() - 1_000) },
  });
  const second = await dispatcher.claim(outbox.id);

  await assert.rejects(
    dispatcher.process(outbox.id, first.leaseToken ?? "missing"),
  );
  await dispatcher.process(outbox.id, second.leaseToken ?? "missing");
  assert.equal(await database.profileEvent.count(), 1);
  assert.equal(await database.consumerInbox.count(), 1);
});
