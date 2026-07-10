import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, test } from "node:test";

import { PrismaClient } from "@prisma/client";

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
  const outbox = await database.domainOutbox.create({
    data: {
      userId: user.id,
      aggregateId: randomUUID(),
      eventType: "health.facts.accepted",
      idempotencyKey: randomUUID(),
      payload: { sync_run_id: randomUUID(), revision_ids: [randomUUID()] },
      consentRequirements: {
        create: { purpose: "health_processing", grantEpoch: 1 },
      },
    },
  });
  return { user, outbox };
}

test("claims with fencing and creates one inbox/profile event across retry", async () => {
  const { outbox } = await message();
  const firstLease = await dispatcher.claim(outbox.id);
  await dispatcher.process(outbox.id, firstLease.leaseToken ?? "missing");
  await dispatcher.process(outbox.id, firstLease.leaseToken ?? "missing");

  assert.equal(await database.consumerInbox.count(), 1);
  assert.equal(await database.profileEvent.count(), 1);
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
