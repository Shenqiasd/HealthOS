import { randomBytes, randomUUID } from "node:crypto";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { DatabaseService } from "../database/prisma.service";
import { SessionService } from "../identity/session.service";
import { SafetyControlsService } from "../kill-switches/safety-controls.service";
import { createApp } from "../main";
import { ReviewsService } from "./reviews.service";

describe("Weekly Review API", () => {
  const database = new DatabaseService();
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env.APPLE_CLIENT_ID = "synthetic.reviews.client";
    process.env.SESSION_SIGNING_SECRET = "synthetic-reviews-session-secret-32-characters";
    process.env.APPLE_SUBJECT_HASH_KEY = "synthetic-reviews-subject-hash-key";
    process.env.DEVICE_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    await database.$connect();
    app = await createApp();
  });
  afterAll(async () => { await app.close(); await database.$disconnect(); });
  beforeEach(async () => {
    await database.$executeRawUnsafe(`
      TRUNCATE TABLE users, rule_bundles, audit_logs, privacy_reconciliation
      RESTART IDENTITY CASCADE
    `);
    await database.privacyReconciliation.create({ data: { id: "global", status: "ready" } });
  });

  async function user() {
    const user = await database.user.create({ data: { consentEpoch: 1 } });
    await database.consentRecord.create({ data: {
      userId: user.id, consentType: "health_processing", documentVersion: "synthetic-review-v1",
      granted: true, epoch: 1, correlationId: randomUUID(), requestHash: randomUUID(), source: "synthetic",
    } });
    const token = await app.get(SessionService).issue(user.id);
    return { user, token: token.accessToken };
  }

  async function withMissingControlEpoch<T>(callback: () => Promise<T>): Promise<T> {
    const epoch = await database.safetyControlEpoch.findUniqueOrThrow({ where: { id: "global" } });
    await database.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      await tx.$executeRaw`DELETE FROM "safety_control_epoch" WHERE "id" = 'global'`;
    });
    try {
      return await callback();
    } finally {
      await database.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
        await tx.$executeRaw`
          INSERT INTO "safety_control_epoch"("id", "version", "updated_at")
          VALUES ('global', ${epoch.version}, ${epoch.updatedAt})
        `;
      });
    }
  }

  test("authenticates generation, validates the window, and exactly replays one request", async () => {
    const identity = await user();
    const idempotencyKey = randomUUID();
    const body = {
      week_start: "2026-06-29",
      cutoff_at: "2026-07-06T00:00:00.000Z",
      idempotency_key: idempotencyKey,
    };
    expect((await app.inject({ method: "POST", url: "/reviews/generations", payload: body })).statusCode).toBe(401);
    const first = await app.inject({
      method: "POST", url: "/reviews/generations", payload: body,
      headers: { authorization: `Bearer ${identity.token}` },
    });
    expect(first.statusCode).toBe(201);
    const replay = await app.inject({
      method: "POST", url: "/reviews/generations", payload: body,
      headers: { authorization: `Bearer ${identity.token}` },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    const conflict = await app.inject({
      method: "POST", url: "/reviews/generations",
      payload: { ...body, cutoff_at: "2026-07-07T00:00:00.000Z" },
      headers: { authorization: `Bearer ${identity.token}` },
    });
    expect(conflict.statusCode).toBe(409);
    expect(await database.domainOutbox.count({ where: { userId: identity.user.id } })).toBe(1);
  });

  test("fails closed for missing Review, withdrawn consent, and invalid share variant", async () => {
    const identity = await user();
    const headers = { authorization: `Bearer ${identity.token}` };
    expect((await app.inject({ method: "GET", url: "/reviews/current", headers })).statusCode).toBe(404);
    expect((await app.inject({
      method: "GET", url: `/reviews/${randomUUID()}/shares/public`, headers,
    })).statusCode).toBe(400);
    await database.consentRecord.create({ data: {
      userId: identity.user.id, consentType: "health_processing", documentVersion: "synthetic-review-v2",
      granted: false, epoch: 2, correlationId: randomUUID(), requestHash: randomUUID(), source: "synthetic",
    } });
    expect((await app.inject({ method: "GET", url: "/reviews/current", headers })).statusCode).toBe(403);
  });

  test("returns only owner-scoped unexpired Review and redacted share payloads", async () => {
    const identity = await user();
    const provenance = {
      week_start: "2026-06-29",
      cutoff_at: "2026-07-06T00:00:00.000Z",
      consent_epoch: 1,
      signal_snapshot_ids: [], action_assignment_ids: [], feedback_event_ids: [],
    };
    const review = await database.weeklyReviewSnapshot.create({ data: {
      userId: identity.user.id,
      weekStart: new Date("2026-06-29T00:00:00.000Z"),
      cutoffAt: new Date("2026-07-06T00:00:00.000Z"),
      consentEpoch: 1,
      coverage: 0,
      conclusion: "review.conclusion.no_data",
      evidenceJson: [],
      frictionJson: { code: "review.friction.no_actions", completed: 0, skipped: 0, replaced: 0 },
      nextActionsJson: [],
      provenanceJson: provenance,
      sourceHash: "0".repeat(64), snapshotHash: "0".repeat(64), revision: 1,
    } });
    const payload = {
      schema_version: 1,
      review_id: review.id,
      variant: "redacted",
      week_start: "2026-06-29",
      week_end: "2026-07-05",
      coverage: 0,
      conclusion_key: "review.conclusion.no_data",
      evidence: [],
      friction: { code: "review.friction.no_actions", completed: 0, skipped: 0, replaced: 0 },
      next_actions: [],
    };
    const share = await database.weeklyReviewShare.create({ data: {
      weeklyReviewSnapshotId: review.id,
      userId: identity.user.id,
      variant: "redacted",
      payloadJson: payload,
      payloadHash: "0".repeat(64),
      expiresAt: new Date("2026-07-20T00:00:00.000Z"),
    } });
    await expect(database.weeklyReviewShare.create({ data: {
      weeklyReviewSnapshotId: review.id,
      userId: identity.user.id,
      variant: "private",
      payloadJson: { ...payload, variant: "private", raw_value: 42 },
      payloadHash: "0".repeat(64),
      expiresAt: new Date("2026-07-20T00:00:00.000Z"),
    } })).rejects.toThrow(/immutable review/i);
    const headers = { authorization: `Bearer ${identity.token}` };
    const current = await app.inject({ method: "GET", url: "/reviews/current?week_start=2026-06-29", headers });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ id: review.id, conclusion_key: "review.conclusion.no_data" });
    await withMissingControlEpoch(async () => {
      expect((await app.inject({
        method: "GET", url: `/reviews/${review.id}/shares/redacted`, headers,
      })).statusCode).toBe(503);
    });
    const disabledShare = await app.inject({ method: "GET", url: `/reviews/${review.id}/shares/redacted`, headers });
    expect(disabledShare.statusCode).toBe(410);
    const operator = await database.adminActor.create({ data: {
      lookupHash: "a".repeat(64),
      displayLabel: "Synthetic Review operator",
      roles: { create: [{ role: "operator" }] },
    } });
    const controls = app.get(SafetyControlsService);
    const principal = {
      actorId: operator.id,
      displayLabel: operator.displayLabel,
      roles: ["operator" as const],
      subjectUserIds: [],
    };
    await controls.mutate(principal, {
      control_type: "feature_flag",
      control_key: "feature.weekly_review_share",
      scope_type: "global",
      scope_id: "*",
      active: true,
      expected_version: 0,
      idempotency_key: randomUUID(),
      reason: "synthetic_test" as const,
    }, randomUUID());
    const redacted = await app.inject({ method: "GET", url: `/reviews/${review.id}/shares/redacted`, headers });
    expect(redacted.statusCode).toBe(200);
    expect(redacted.body).not.toMatch(/user_id|fact_revision|canonical_value|account/);

    const control = {
      control_type: "kill_switch" as const,
      control_key: "review.share",
      scope_type: "global" as const,
      scope_id: "*",
      active: true,
      expected_version: 0,
      idempotency_key: randomUUID(),
      reason: "synthetic_test" as const,
    };
    const blocker = new DatabaseService();
    await blocker.$connect();
    let releaseEpoch!: () => void;
    let epochLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseEpoch = resolve; });
    const locked = new Promise<void>((resolve) => { epochLocked = resolve; });
    const blockingTransaction = blocker.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "safety_control_epoch" WHERE "id" = 'global' FOR UPDATE`;
      epochLocked();
      await release;
    });
    await locked;
    try {
      const activation = controls.mutate(principal, control, randomUUID());
      await new Promise((resolve) => setTimeout(resolve, 20));
      let shareSettled = false;
      const concurrentShare = app.inject({
        method: "GET", url: `/reviews/${review.id}/shares/redacted`, headers,
      }).then((response) => {
        shareSettled = true;
        return response;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(shareSettled).toBe(false);
      releaseEpoch();
      await blockingTransaction;
      await activation;
      expect((await concurrentShare).statusCode).toBe(410);
    } finally {
      releaseEpoch();
      await blockingTransaction;
      await blocker.$disconnect();
    }
    await controls.mutate(principal, {
      ...control,
      active: false,
      expected_version: 1,
      idempotency_key: randomUUID(),
      reason: "synthetic_test" as const,
    }, randomUUID());
    expect((await app.inject({
      method: "GET", url: `/reviews/${review.id}/shares/redacted`, headers,
    })).statusCode).toBe(200);

    const other = await user();
    expect((await app.inject({
      method: "GET",
      url: `/reviews/${review.id}/shares/redacted`,
      headers: { authorization: `Bearer ${other.token}` },
    })).statusCode).toBe(404);
    await expect(app.get(ReviewsService).share(
      identity.user.id,
      review.id,
      "redacted",
      new Date("2026-07-21T00:00:00.000Z"),
    )).rejects.toThrow(/expired/i);
    expect(share.payloadHash).not.toBe("0".repeat(64));
  });
});
