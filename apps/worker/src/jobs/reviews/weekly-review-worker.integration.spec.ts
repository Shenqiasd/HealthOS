import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, beforeEach, describe } from "node:test";

import { PrismaClient } from "@prisma/client";

import { WeeklyReviewDispatcher } from "./weekly-review-dispatcher";
import { WeeklyReviewWorker } from "./weekly-review-worker";

const database = new PrismaClient();
const weekStart = "2026-07-06";
const cutoffAt = new Date("2026-07-13T00:00:00.000Z");

describe("weekly Review database integration", { concurrency: 1 }, () => {
before(async () => database.$connect());
after(async () => database.$disconnect());
beforeEach(async () => {
  await database.$executeRawUnsafe(`
    TRUNCATE TABLE users, rule_bundles, audit_logs, privacy_reconciliation
    RESTART IDENTITY CASCADE
  `);
  await database.privacyReconciliation.create({ data: { id: "global", status: "ready" } });
});

async function authorizedUser() {
  const user = await database.user.create({ data: { consentEpoch: 1 } });
  await database.consentRecord.create({ data: {
    userId: user.id,
    consentType: "health_processing",
    documentVersion: "synthetic-review-v1",
    granted: true,
    epoch: 1,
    correlationId: randomUUID(),
    requestHash: randomUUID(),
    source: "synthetic",
  } });
  return user;
}

function worker() {
  return new WeeklyReviewWorker(database, {
    shareTtlSeconds: 7 * 24 * 60 * 60,
    now: () => new Date("2026-07-13T00:05:00.000Z"),
  });
}

test("creates one immutable no-data snapshot and two privacy variants exactly once", async () => {
  const user = await authorizedUser();
  const input = { userId: user.id, weekStart, cutoffAt, consentEpoch: 1 };
  const first = await worker().project(input);
  const replay = await worker().project(input);

  assert.equal(replay.id, first.id);
  assert.equal(first.conclusion, "review.conclusion.no_data");
  assert.equal(Number(first.coverage), 0);
  assert.equal(first.shares.length, 2);
  const redacted = first.shares.find((item) => item.variant === "redacted");
  assert.equal(JSON.stringify(redacted?.payloadJson).includes("user_id"), false);
  assert.notEqual(first.sourceHash, "0".repeat(64));
  assert.notEqual(first.snapshotHash, "0".repeat(64));
  const secondUser = await authorizedUser();
  const second = await worker().project({ ...input, userId: secondUser.id });
  assert.notEqual(second.id, first.id);
  await assert.rejects(database.weeklyReviewSnapshot.update({
    where: { id: first.id }, data: { conclusion: "review.conclusion.stable" },
  }), /append-only/i);
});

test("retries a failed generation and records one consumer result", async () => {
  const user = await authorizedUser();
  const outbox = await database.domainOutbox.create({ data: {
    eventType: "weekly_review.generate_requested",
    aggregateId: user.id,
    userId: user.id,
    idempotencyKey: `synthetic-review-${randomUUID()}`,
    payload: { user_id: user.id, week_start: weekStart, cutoff_at: cutoffAt.toISOString(), consent_epoch: 1 },
  } });
  const real = worker();
  let attempts = 0;
  const retrying = {
    project: async (input: Parameters<WeeklyReviewWorker["project"]>[0]) => {
      attempts += 1;
      if (attempts === 1) throw new Error("synthetic transient failure");
      return real.project(input);
    },
  } as unknown as WeeklyReviewWorker;
  const dispatcher = new WeeklyReviewDispatcher(database, retrying, {
    leaseSeconds: 30, pollMilliseconds: 60_000,
  });

  await assert.rejects(dispatcher.drainOnce(), /synthetic transient/i);
  assert.equal((await database.domainOutbox.findUniqueOrThrow({ where: { id: outbox.id } })).status, "failed");
  assert.equal(await dispatcher.drainOnce(), true);
  assert.equal((await database.domainOutbox.findUniqueOrThrow({ where: { id: outbox.id } })).status, "sent");
  assert.equal(await database.consumerInbox.count({
    where: { consumer: "weekly-review-projector-v1", messageId: outbox.id },
  }), 1);
  assert.equal(await database.weeklyReviewSnapshot.count({ where: { userId: user.id } }), 1);
});

test("rejects forged semantics and removes reviews and shares only through exact privacy deletion", async () => {
  const user = await authorizedUser();
  await assert.rejects(database.weeklyReviewSnapshot.create({ data: {
    userId: user.id,
    weekStart: new Date(`${weekStart}T00:00:00.000Z`),
    cutoffAt,
    consentEpoch: 1,
    coverage: 1,
    conclusion: "diagnosis",
    evidenceJson: [],
    frictionJson: { code: "review.friction.no_actions", completed: 0, skipped: 0, replaced: 0 },
    nextActionsJson: [],
    provenanceJson: { week_start: weekStart, cutoff_at: cutoffAt.toISOString(), consent_epoch: 1 },
    sourceHash: "0".repeat(64),
    snapshotHash: "0".repeat(64),
    revision: 1,
  } }), /semantic/i);
  await assert.rejects(database.weeklyReviewSnapshot.create({ data: {
    userId: user.id,
    weekStart: new Date(`${weekStart}T00:00:00.000Z`),
    cutoffAt,
    consentEpoch: 1,
    coverage: 0,
    conclusion: "review.conclusion.stable",
    evidenceJson: [],
    frictionJson: { code: "review.friction.no_actions", completed: 0, skipped: 0, replaced: 0 },
    nextActionsJson: [],
    provenanceJson: {
      week_start: weekStart, cutoff_at: cutoffAt.toISOString(), consent_epoch: 1,
      signal_snapshot_ids: [], action_assignment_ids: [], feedback_event_ids: [],
    },
    sourceHash: "0".repeat(64),
    snapshotHash: "0".repeat(64),
    revision: 1,
  } }), /deterministic/i);
  const snapshot = await worker().project({ userId: user.id, weekStart, cutoffAt, consentEpoch: 1 });
  await database.user.update({ where: { id: user.id }, data: { status: "deleting", deletedAt: new Date() } });
  await database.$queryRaw`SELECT "healthos_delete_frozen_user"(${user.id}::uuid)`;
  assert.equal(await database.weeklyReviewSnapshot.count({ where: { id: snapshot.id } }), 0);
  assert.equal(await database.weeklyReviewShare.count({ where: { weeklyReviewSnapshotId: snapshot.id } }), 0);
});
});
