import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, test } from "node:test";

import { PrismaClient } from "@prisma/client";
import type { Prisma } from "@prisma/client";

import {
  ProfileProjectionWorker,
  replayProfileEvents,
} from "./profile-projection-worker";

const database = new PrismaClient();
const worker = new ProfileProjectionWorker(database, { leaseSeconds: 30 });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForLockWaiters(minimum: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await database.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS "count"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
    `;
    if ((row?.count ?? 0n) >= BigInt(minimum)) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${minimum} PostgreSQL lock waiters`);
}

before(async () => database.$connect());

afterEach(async () => {
  await database.$executeRawUnsafe(`
    TRUNCATE TABLE
      consumer_inbox,
      domain_outbox_consent_requirements,
      domain_outbox,
      profile_snapshots,
      profile_events,
      profile_candidates,
      consent_records,
      users
    RESTART IDENTITY CASCADE
  `);
});

after(async () => database.$disconnect());

async function authorizedUser() {
  const user = await database.user.create({ data: { consentEpoch: 1 } });
  await database.consentRecord.create({
    data: {
      userId: user.id,
      consentType: "health_processing",
      documentVersion: "health-v1",
      granted: true,
      epoch: 1,
      correlationId: randomUUID(),
      requestHash: randomUUID(),
      source: "synthetic",
    },
  });
  return user;
}

async function appendMessage(
  userId: string,
  eventType: string,
  payload: Record<string, unknown>,
  occurredAt = new Date(),
) {
  const event = await database.profileEvent.create({
    data: {
      userId,
      eventType,
      source: "synthetic",
      payload: payload as unknown as Prisma.InputJsonObject,
      consentEpoch: 1,
      payloadHash: "a".repeat(64),
      correlationId: randomUUID(),
      occurredAt,
    },
  });
  const outbox = await database.domainOutbox.create({
    data: {
      userId,
      aggregateId: event.id,
      eventType: "profile.event.appended",
      idempotencyKey: `profile.event.appended:${event.id}`,
      payload: { profile_event_id: event.id, event_sequence: event.sequence.toString() },
      consentRequirements: {
        create: { purpose: "health_processing", grantEpoch: 1 },
      },
    },
  });
  return { event, outbox };
}

test("projects every missing event in sequence even when delivery is out of order", async () => {
  const user = await authorizedUser();
  const first = await appendMessage(user.id, "limitation_confirmed", {
    code: "knee_discomfort",
    active: true,
  });
  const second = await appendMessage(user.id, "lab_value_corrected", {
    field_code: "uric_acid",
    value: 410,
    unit: "umol/L",
  });

  const secondLease = await worker.claim(second.outbox.id);
  await worker.process(second.outbox.id, secondLease.leaseToken ?? "missing");
  const firstLease = await worker.claim(first.outbox.id);
  await worker.process(first.outbox.id, firstLease.leaseToken ?? "missing");

  const snapshots = await database.profileSnapshot.findMany({
    where: { userId: user.id },
    orderBy: { version: "asc" },
  });
  assert.deepEqual(snapshots.map((snapshot) => snapshot.version), [1, 2]);
  assert.equal(snapshots[1]?.sourceSequence, second.event.sequence);
  assert.equal(await database.consumerInbox.count(), 2);

  const sourceEvents = await database.profileEvent.findMany({
    where: { userId: user.id },
    orderBy: { sequence: "asc" },
  });
  const replay = replayProfileEvents(sourceEvents);
  assert.deepEqual(
    replay.map((snapshot) => snapshot.snapshotHash),
    snapshots.map((snapshot) => snapshot.snapshotHash),
  );
});

test("treats a late correction as a new ordered version and replay stays deterministic", async () => {
  const user = await authorizedUser();
  const original = await appendMessage(user.id, "lab_value_corrected", {
    field_code: "uric_acid",
    value: 430,
    unit: "umol/L",
  }, new Date("2026-07-10T10:00:00.000Z"));
  const correction = await appendMessage(user.id, "lab_value_corrected", {
    field_code: "uric_acid",
    value: 390,
    unit: "umol/L",
  }, new Date("2026-07-01T10:00:00.000Z"));

  const lease = await worker.claim(correction.outbox.id);
  await worker.process(correction.outbox.id, lease.leaseToken ?? "missing");
  const snapshots = await database.profileSnapshot.findMany({
    where: { userId: user.id },
    orderBy: { version: "asc" },
  });
  assert.equal(snapshots.length, 2);
  const facts = snapshots[1]?.factsJson as Prisma.JsonObject;
  const labs = facts.labs as Prisma.JsonObject;
  const uricAcid = labs.uric_acid as Prisma.JsonObject;
  assert.equal(uricAcid.value, 390);
  assert.ok(correction.event.sequence > original.event.sequence);
});

test("suppresses projection when consent changes after claim", async () => {
  const user = await authorizedUser();
  const message = await appendMessage(user.id, "limitation_confirmed", {
    code: "knee_discomfort",
    active: true,
  });
  const lease = await worker.claim(message.outbox.id);
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

  await worker.process(message.outbox.id, lease.leaseToken ?? "missing");
  assert.equal(await database.profileSnapshot.count(), 0);
  assert.equal((await database.domainOutbox.findUniqueOrThrow({
    where: { id: message.outbox.id },
  })).status, "suppressed");
});

test("linearizes projection and consent withdrawal on the user lock", async () => {
  const withdrawalFirstUser = await authorizedUser();
  const withdrawalFirstMessage = await appendMessage(
    withdrawalFirstUser.id,
    "limitation_confirmed",
    { code: "knee_discomfort", active: true },
  );
  const withdrawalFirstLease = await worker.claim(withdrawalFirstMessage.outbox.id);
  const withdrawalLocked = deferred();
  const releaseWithdrawal = deferred();
  const withdrawal = database.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id" FROM "users"
      WHERE "id" = ${withdrawalFirstUser.id}::uuid
      FOR UPDATE
    `;
    await tx.consentRecord.create({
      data: {
        userId: withdrawalFirstUser.id,
        consentType: "health_processing",
        documentVersion: "health-v1",
        granted: false,
        epoch: 2,
        correlationId: randomUUID(),
        requestHash: randomUUID(),
        source: "synthetic",
      },
    });
    await tx.user.update({
      where: { id: withdrawalFirstUser.id },
      data: { consentEpoch: 2 },
    });
    withdrawalLocked.resolve();
    await releaseWithdrawal.promise;
  });
  await withdrawalLocked.promise;
  const suppressedProjection = worker.process(
    withdrawalFirstMessage.outbox.id,
    withdrawalFirstLease.leaseToken ?? "missing",
  );
  await waitForLockWaiters(1);
  releaseWithdrawal.resolve();
  await withdrawal;
  await suppressedProjection;
  assert.equal(await database.profileSnapshot.count({
    where: { userId: withdrawalFirstUser.id },
  }), 0);

  const projectionFirstUser = await authorizedUser();
  const projectionFirstMessage = await appendMessage(
    projectionFirstUser.id,
    "limitation_confirmed",
    { code: "back_discomfort", active: true },
  );
  const projectionFirstLease = await worker.claim(projectionFirstMessage.outbox.id);
  const blockerLocked = deferred();
  const releaseBlocker = deferred();
  const blocker = database.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id" FROM "users"
      WHERE "id" = ${projectionFirstUser.id}::uuid
      FOR UPDATE
    `;
    blockerLocked.resolve();
    await releaseBlocker.promise;
  });
  await blockerLocked.promise;
  const projected = worker.process(
    projectionFirstMessage.outbox.id,
    projectionFirstLease.leaseToken ?? "missing",
  );
  await waitForLockWaiters(1);
  const laterWithdrawal = database.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id" FROM "users"
      WHERE "id" = ${projectionFirstUser.id}::uuid
      FOR UPDATE
    `;
    await tx.consentRecord.create({
      data: {
        userId: projectionFirstUser.id,
        consentType: "health_processing",
        documentVersion: "health-v1",
        granted: false,
        epoch: 2,
        correlationId: randomUUID(),
        requestHash: randomUUID(),
        source: "synthetic",
      },
    });
    await tx.user.update({
      where: { id: projectionFirstUser.id },
      data: { consentEpoch: 2 },
    });
  });
  await waitForLockWaiters(2);
  releaseBlocker.resolve();
  await blocker;
  await projected;
  await laterWithdrawal;
  assert.equal(await database.profileSnapshot.count({
    where: { userId: projectionFirstUser.id },
  }), 1);
  assert.equal((await database.consentRecord.findFirstOrThrow({
    where: { userId: projectionFirstUser.id, consentType: "health_processing" },
    orderBy: { epoch: "desc" },
  })).granted, false);
});

test("reclaims expired work and fences the stale lease", async () => {
  const user = await authorizedUser();
  const message = await appendMessage(user.id, "limitation_confirmed", {
    code: "knee_discomfort",
    active: true,
  });
  const first = await worker.claim(message.outbox.id);
  await database.domainOutbox.update({
    where: { id: message.outbox.id },
    data: { leaseUntil: new Date(Date.now() - 1_000) },
  });
  const second = await worker.claim(message.outbox.id);
  await assert.rejects(worker.process(message.outbox.id, first.leaseToken ?? "missing"));
  await worker.process(message.outbox.id, second.leaseToken ?? "missing");
  assert.equal(await database.profileSnapshot.count(), 1);
});

test("does not claim future work or commit with an expired lease", async () => {
  const user = await authorizedUser();
  const message = await appendMessage(user.id, "limitation_confirmed", {
    code: "knee_discomfort",
    active: true,
  });
  await database.domainOutbox.update({
    where: { id: message.outbox.id },
    data: { availableAt: new Date(Date.now() + 60_000) },
  });
  await assert.rejects(worker.claim(message.outbox.id));
  await database.domainOutbox.update({
    where: { id: message.outbox.id },
    data: { availableAt: new Date(Date.now() - 1_000) },
  });
  const lease = await worker.claim(message.outbox.id);
  await database.domainOutbox.update({
    where: { id: message.outbox.id },
    data: { leaseUntil: new Date(Date.now() - 1_000) },
  });
  await assert.rejects(worker.process(message.outbox.id, lease.leaseToken ?? "missing"));
  assert.equal(await database.profileSnapshot.count(), 0);
});

test("serializes concurrent workers for one user", async () => {
  const user = await authorizedUser();
  const first = await appendMessage(user.id, "limitation_confirmed", {
    code: "knee_discomfort",
    active: true,
  });
  const second = await appendMessage(user.id, "lab_value_corrected", {
    field_code: "uric_acid",
    value: 400,
    unit: "umol/L",
  });
  const [firstLease, secondLease] = await Promise.all([
    worker.claim(first.outbox.id),
    worker.claim(second.outbox.id),
  ]);
  await Promise.all([
    worker.process(second.outbox.id, secondLease.leaseToken ?? "missing"),
    worker.process(first.outbox.id, firstLease.leaseToken ?? "missing"),
  ]);
  const snapshots = await database.profileSnapshot.findMany({
    where: { userId: user.id },
    orderBy: { version: "asc" },
  });
  assert.deepEqual(snapshots.map((snapshot) => snapshot.version), [1, 2]);
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.sourceSequence),
    [first.event.sequence, second.event.sequence],
  );
});

test("rolls back inbox, snapshots, and acknowledgement on unsupported ledger input", async () => {
  const user = await authorizedUser();
  const message = await appendMessage(user.id, "synthetic_profile_created", {});
  const lease = await worker.claim(message.outbox.id);
  await assert.rejects(
    worker.process(message.outbox.id, lease.leaseToken ?? "missing"),
    /unsupported profile event/i,
  );
  assert.equal(await database.profileSnapshot.count(), 0);
  assert.equal(await database.consumerInbox.count(), 0);
  assert.equal((await database.domainOutbox.findUniqueOrThrow({
    where: { id: message.outbox.id },
  })).status, "leased");
});
