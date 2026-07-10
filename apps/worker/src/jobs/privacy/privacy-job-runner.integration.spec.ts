import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { PrismaClient } from "@prisma/client";

import { FilePrivacyControlStore } from "./file-privacy-control.store";
import { PrivacyJobRunner } from "./privacy-job-runner";

const database = new PrismaClient();
const tombstoneHashKey = "synthetic-tombstone-hash-key-at-least-32-bytes";
let controlRoot: string;
let privacyControl: FilePrivacyControlStore;
let runner: PrivacyJobRunner;

function lookupHash(userId: string): string {
  return createHmac("sha256", tombstoneHashKey)
    .update(`deleted-user:${userId}`, "utf8")
    .digest("hex");
}

before(async () => {
  await database.$connect();
});

beforeEach(async () => {
  controlRoot = await mkdtemp(join(tmpdir(), "healthos-privacy-control-"));
  privacyControl = new FilePrivacyControlStore(controlRoot);
  runner = new PrivacyJobRunner(
    database,
    { tombstoneHashKeys: { "synthetic-v1": tombstoneHashKey } },
    privacyControl,
  );
});

afterEach(async () => {
  await database.$executeRawUnsafe(`
    TRUNCATE TABLE
      deletion_jobs,
      export_jobs,
      consent_records,
      channel_outbox,
      users
    RESTART IDENTITY CASCADE
  `);
  await database.privacyReconciliation.upsert({
    where: { id: "global" },
    create: { id: "global", status: "required" },
    update: {
      status: "required",
      startedAt: null,
      completedAt: null,
      errorCode: null,
    },
  });
  await rm(controlRoot, { recursive: true, force: true });
});

after(async () => {
  await database.$disconnect();
});

test("export jobs retry and expire through explicit states", async () => {
  const user = await database.user.create({ data: {} });
  const job = await database.exportJob.create({
    data: {
      userId: user.id,
      idempotencyKey: randomUUID(),
      requestHash: "synthetic-export-request",
    },
  });

  const firstLease = await runner.startExport(job.id);
  await runner.failExport(
    job.id,
    firstLease.leaseToken ?? "missing",
    "SYNTHETIC_STORAGE_UNAVAILABLE",
  );
  const retried = await runner.startExport(job.id);
  assert.equal(retried.status, "generating");
  assert.equal(retried.attempt, 2);

  const expiresAt = new Date("2030-01-02T00:00:00.000Z");
  await runner.completeExport(
    job.id,
    retried.leaseToken ?? "missing",
    "synthetic/exports/artifact.json",
    "a".repeat(64),
    expiresAt,
  );
  await runner.expireExports(new Date("2030-01-03T00:00:00.000Z"));
  const expired = await database.exportJob.findUniqueOrThrow({
    where: { id: job.id },
  });
  assert.equal(expired.status, "expired");
  await assert.rejects(
    database.exportJob.update({
      where: { id: job.id },
      data: { status: "generating" },
    }),
  );
});

test("deletion retries, hard-deletes the user, and leaves only a minimal tombstone", async () => {
  const user = await database.user.create({
    data: { status: "deleting", deletedAt: new Date() },
  });
  await database.consentRecord.create({
    data: {
      correlationId: randomUUID(),
      consentType: "health_processing",
      documentVersion: "health-v1",
      epoch: 1,
      granted: true,
      requestHash: "synthetic-consent-request",
      source: "synthetic",
      userId: user.id,
    },
  });
  const job = await database.deletionJob.create({
    data: {
      idempotencyKey: randomUUID(),
      statusTokenHash: "synthetic-status-token-hash",
      hashKeyVersion: "synthetic-v1",
      status: "frozen",
      userId: user.id,
      userLookupHash: lookupHash(user.id),
    },
  });
  await privacyControl.beginDeletionFence({
    deletion_job_id: job.id,
    hash_key_version: "synthetic-v1",
    user_lookup_hash: lookupHash(user.id),
  });

  const firstLease = await runner.startDeletion(job.id);
  await runner.failDeletion(
    job.id,
    firstLease.leaseToken ?? "missing",
    "SYNTHETIC_RETRY",
  );
  const retried = await runner.startDeletion(job.id);
  assert.equal(retried.attempt, 2);
  await runner.completeDeletion(job.id, retried.leaseToken ?? "missing");
  await runner.completeDeletion(job.id, retried.leaseToken ?? "missing");

  assert.equal(await database.user.count({ where: { id: user.id } }), 0);
  const completed = await database.deletionJob.findUniqueOrThrow({
    where: { id: job.id },
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.userId, null);
  const fences = await privacyControl.listCompletedDeletionFences();
  assert.equal(fences.length, 1);
  assert.equal(JSON.stringify(fences[0]).includes(user.id), false);
});

test("restore reconciliation deletes tombstoned users and suppresses invalid outbox", async () => {
  const restoredUserId = randomUUID();
  await database.user.create({ data: { id: restoredUserId } });
  const restoredDeletionJobId = randomUUID();
  await privacyControl.beginDeletionFence({
    deletion_job_id: restoredDeletionJobId,
    hash_key_version: "synthetic-v1",
    user_lookup_hash: lookupHash(restoredUserId),
  });
  await privacyControl.completeDeletionFence(
    lookupHash(restoredUserId),
    restoredDeletionJobId,
  );

  const noConsentUser = await database.user.create({ data: {} });
  const suppressedOutbox = await database.channelOutbox.create({
    data: {
      channel: "apns",
      idempotencyKey: randomUUID(),
      payload: { template_data: "synthetic" },
      template: "daily_ready",
      userId: noConsentUser.id,
      consentRequirements: {
        create: { purpose: "notifications", grantEpoch: 1 },
      },
    },
  });

  const authorizedUser = await database.user.create({
    data: { consentEpoch: 1 },
  });
  await database.consentRecord.create({
    data: {
      correlationId: randomUUID(),
      consentType: "notifications",
      documentVersion: "notifications-v1",
      epoch: 1,
      granted: true,
      requestHash: "synthetic-notification-consent",
      source: "synthetic",
      userId: authorizedUser.id,
    },
  });
  const authorizedOutbox = await database.channelOutbox.create({
    data: {
      channel: "apns",
      idempotencyKey: randomUUID(),
      payload: { template_data: "synthetic" },
      template: "daily_ready",
      userId: authorizedUser.id,
      consentRequirements: {
        create: { purpose: "notifications", grantEpoch: 1 },
      },
    },
  });

  await runner.reconcileAfterRestore("synthetic-restore-run", "synthetic-backup");

  assert.equal(await database.user.count({ where: { id: restoredUserId } }), 0);
  assert.equal(
    (await database.channelOutbox.findUniqueOrThrow({
      where: { id: suppressedOutbox.id },
    })).status,
    "suppressed",
  );
  assert.equal(
    (await database.channelOutbox.findUniqueOrThrow({
      where: { id: authorizedOutbox.id },
    })).status,
    "pending",
  );
  assert.equal(
    (await database.privacyReconciliation.findUniqueOrThrow({
      where: { id: "global" },
    })).status,
    "ready",
  );
  assert.equal(await privacyControl.isSendAllowed(), true);
});
