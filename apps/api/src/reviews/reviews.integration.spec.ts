import { randomBytes, randomUUID } from "node:crypto";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { DatabaseService } from "../database/prisma.service";
import { SessionService } from "../identity/session.service";
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
    const redacted = await app.inject({ method: "GET", url: `/reviews/${review.id}/shares/redacted`, headers });
    expect(redacted.statusCode).toBe(200);
    expect(redacted.body).not.toMatch(/user_id|fact_revision|canonical_value|account/);

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
