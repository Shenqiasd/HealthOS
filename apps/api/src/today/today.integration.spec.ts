import { randomBytes, randomUUID } from "node:crypto";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createApp } from "../main";
import { DatabaseService } from "../database/prisma.service";
import { PublicationRepository } from "../database/publication.repository";
import { SessionService } from "../identity/session.service";
import { RecommendationRunService } from "../recommendations/recommendation-run.service";
import {
  RULES_ENGINE_ARTIFACT_DIGEST,
  RuleBundleService,
} from "../recommendations/rule-bundle.service";
import { TodayService } from "./today.service";

const ruleInput = {
  age_group: "adult",
  pregnancy_state: "none",
  serious_conditions: [],
  diabetes_treatment: false,
  medication_affects_advice: false,
  eating_disorder_risk: false,
  acute_symptoms: false,
  mobility_limited: false,
  freshness: "current",
  signals: { sleep_recovery: "elevated" },
  rejected_action_codes: [],
};

interface SyntheticSyncOptions {
  consentEpoch?: number;
  status?: "pending" | "completed" | "failed";
  completedAt?: Date | null;
  omitSync?: boolean;
  crossUserSync?: boolean;
  serverSequenceOffset?: bigint;
}

function shanghaiDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

describe("Today read model", () => {
  const database = new DatabaseService();
  const bundles = new RuleBundleService(database);
  const runs = new RecommendationRunService(database);
  const publication = new PublicationRepository(database);
  const today = new TodayService(database);
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env.APPLE_CLIENT_ID = "synthetic.today.client";
    process.env.SESSION_SIGNING_SECRET = "synthetic-today-session-secret-32-characters";
    process.env.APPLE_SUBJECT_HASH_KEY = "synthetic-today-subject-hash-key";
    process.env.DEVICE_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    await database.$connect();
    app = await createApp();
  });

  afterEach(async () => {
    await database.$executeRawUnsafe(`
      TRUNCATE TABLE users, rule_bundles, audit_logs, privacy_reconciliation
      RESTART IDENTITY CASCADE
    `);
    await database.privacyReconciliation.create({ data: { id: "global", status: "ready" } });
  });

  afterAll(async () => {
    await app.close();
    await database.$disconnect();
  });

  async function authorizedUser() {
    const user = await database.user.create({
      data: { consentEpoch: 1, timezone: "Asia/Shanghai", locale: "zh-CN" },
    });
    await database.consentRecord.create({
      data: {
        userId: user.id,
        consentType: "health_processing",
        documentVersion: "synthetic-today-v1",
        granted: true,
        epoch: 1,
        correlationId: randomUUID(),
        requestHash: randomUUID(),
        source: "synthetic",
      },
    });
    return user;
  }

  async function profileFor(userId: string, version = 1) {
    const event = await database.profileEvent.create({
      data: {
        userId,
        consentEpoch: 1,
        eventType: "limitation_confirmed",
        source: "synthetic",
        payload: { code: version === 1 ? "none" : "new_limitation", active: version > 1 },
        payloadHash: String(version).repeat(64),
        correlationId: randomUUID(),
      },
    });
    return database.profileSnapshot.create({
      data: {
        userId,
        version,
        consentEpoch: 1,
        factsJson: { limitations: {}, rule_input: ruleInput },
        sourceEventUntil: event.id,
        sourceSequence: event.sequence,
        snapshotHash: version === 1 ? "a".repeat(64) : "b".repeat(64),
      },
    });
  }

  async function syncedFact(
    userId: string,
    factDate: string,
    coverage: number,
    metric = "steps",
    options: SyntheticSyncOptions = {},
  ) {
    const syncUser = options.crossUserSync
      ? await database.user.create({ data: { timezone: "Asia/Shanghai", locale: "zh-CN" } })
      : null;
    const sync = options.omitSync ? null : await database.healthSyncRun.create({
      data: {
        userId: syncUser?.id ?? userId,
        deviceId: `synthetic-device-${randomUUID()}`,
        anchorEpoch: 1,
        idempotencyKey: randomUUID(),
        requestHash: randomBytes(32).toString("hex"),
        timezone: "Asia/Shanghai",
        consentEpoch: options.consentEpoch ?? 1,
        status: options.status ?? "completed",
        completedAt: options.completedAt === undefined ? new Date() : options.completedAt,
        correlationId: randomUUID(),
      },
    });
    return database.dailyHealthFactRevision.create({
      data: {
        userId,
        localDate: new Date(`${factDate}T00:00:00.000Z`),
        metric,
        canonicalValueJson: { value: 6400 },
        coverage,
        sourceVectorJson: { synthetic: 1 },
        inputHash: randomBytes(32).toString("hex"),
        healthSyncRunId: sync?.id ?? null,
        serverSequence: sync
          ? sync.serverSequence + (options.serverSequenceOffset ?? 0n)
          : null,
      },
    });
  }

  async function activeBundle() {
    const draft = await bundles.create(`synthetic-today-${randomUUID()}`, {
      rules_engine: "deterministic-rules-v1",
      rules_engine_digest: RULES_ENGINE_ARTIFACT_DIGEST,
      safety_bundle_digest: "1".repeat(64),
      localization_bundle_digest: "2".repeat(64),
      template_bundle_digest: "3".repeat(64),
      beta_normal_review_percent: 20,
      rules: [{ code: "synthetic-today" }],
    });
    await bundles.approve(draft.id, {
      role: "technical",
      actorId: `synthetic-tech-${draft.id}`,
      approvedAt: new Date("2026-07-11T00:00:00.000Z"),
    });
    await bundles.approve(draft.id, {
      role: "medical",
      actorId: `synthetic-medical-${draft.id}`,
      approvedAt: new Date("2026-07-11T00:01:00.000Z"),
    });
    return bundles.activate(draft.id, "synthetic-release-owner", false);
  }

  async function publishedToday(input: {
    localDate?: string;
    factDate?: string;
    coverage?: number;
    sync?: SyntheticSyncOptions;
  } = {}) {
    const localDate = input.localDate ?? "2026-07-11";
    const factDate = input.factDate ?? localDate;
    const user = await authorizedUser();
    const profile = await profileFor(user.id);
    const fact = await syncedFact(user.id, factDate, input.coverage ?? 1, "steps", input.sync);
    const bundle = await activeBundle();
    const run = await runs.request({
      userId: user.id,
      localDate,
      profileSnapshotId: profile.id,
      ruleInput,
      factRevisionIds: [fact.id],
      labObservationIds: [],
      correlationId: randomUUID(),
    });
    await database.recommendationRun.update({
      where: { id: run.id },
      data: { status: "completed" },
    });
    const renderedPayload = {
      template: "daily_action_v1",
      action_code: "SLEEP_WIND_DOWN",
      safety_class: "normal",
      risk_area: "sleep_recovery",
    };
    const provenance = {
      profile_snapshot_id: profile.id,
      profile_snapshot_hash: profile.snapshotHash,
      daily_fact_revision_ids: [fact.id],
      daily_fact_input_hashes: [fact.inputHash],
      lab_observation_ids: [],
      lab_observation_hashes: [],
      rule_bundle_id: bundle.id,
      rule_bundle_digest: bundle.bundleDigest,
      rules_engine: "deterministic-rules-v1",
      rules_engine_digest: RULES_ENGINE_ARTIFACT_DIGEST,
      safety_bundle: "1".repeat(64),
      localization_bundle: "2".repeat(64),
      template_bundle: "3".repeat(64),
      prompt_version: null,
      provider_id: null,
      model_id: null,
      rendered_payload_hash: "0".repeat(64),
      generated_at: `${localDate}T01:00:00.000Z`,
      rule_result: {
        outcome: "action",
        safetyClass: "normal",
        riskArea: "sleep_recovery",
        actionCode: "SLEEP_WIND_DOWN",
        reasonCode: "ACTION_SELECTED",
      },
      rule_key: "sleep_recovery:SLEEP_WIND_DOWN",
    };
    const draft = await database.recommendationSnapshot.create({
      data: {
        runId: run.id,
        revision: 1,
        riskArea: "sleep_recovery",
        safetyClass: "normal",
        actionCode: "SLEEP_WIND_DOWN",
        renderedPayloadJson: renderedPayload,
        canonicalRuleInputJson: ruleInput,
        provenanceJson: provenance,
        reviewStatus: "review_required",
        releaseStage: "alpha",
        reviewRoute: "review_required",
        policyDigest: "5".repeat(64),
        reviewSamplePercent: 20,
      },
    });
    await database.recommendationReviewEvent.create({
      data: { snapshotId: draft.id, eventType: "submitted" },
    });
    await database.recommendationReviewTask.create({
      data: {
        snapshotId: draft.id,
        priority: "normal",
        slaAt: new Date(Date.now() + 60_000),
        reasonCode: "SYNTHETIC_TODAY_REVIEW",
      },
    });
    const result = await publication.publishReviewed({
      draftSnapshotId: draft.id,
      actorId: "synthetic-today-reviewer",
      reasonCode: "SYNTHETIC_TODAY_APPROVAL",
    });
    return { ...result, bundle, fact, profile, run, user };
  }

  test("requires an active user, current processing consent, and ready privacy state", async () => {
    const user = await database.user.create({ data: { consentEpoch: 0 } });
    await expect(today.get(user.id, randomUUID(), new Date("2026-07-11T08:00:00.000Z")))
      .rejects.toThrow(/authorization/i);
    await database.consentRecord.create({
      data: {
        userId: user.id,
        consentType: "health_processing",
        documentVersion: "synthetic-v1",
        granted: true,
        epoch: 1,
        correlationId: randomUUID(),
        requestHash: randomUUID(),
        source: "synthetic",
      },
    });
    await database.privacyReconciliation.update({ where: { id: "global" }, data: { status: "failed" } });
    await expect(today.get(user.id, randomUUID(), new Date("2026-07-11T08:00:00.000Z")))
      .rejects.toThrow(/authorization/i);
  });

  test("returns one explicit first-launch recovery and no phantom action", async () => {
    const user = await authorizedUser();
    const response = await today.get(user.id, "correlation-first", new Date("2026-07-11T08:00:00.000Z"));
    expect(response).toMatchObject({
      schema_version: 1,
      state: "first_launch",
      local_date: "2026-07-11",
      action: null,
      recovery: { code: "first_launch", primary_command: "open_permissions" },
      correlation_id: "correlation-first",
    });
  });

  test("returns awaiting recommendation when current data and profile exist without a publication", async () => {
    const user = await authorizedUser();
    await profileFor(user.id);
    await syncedFact(user.id, "2026-07-11", 0.5);
    const response = await today.get(user.id, "awaiting", new Date("2026-07-11T08:00:00.000Z"));
    expect(response.state).toBe("awaiting_recommendation");
    expect(response.freshness).toMatchObject({ status: "partial", coverage: 0.5 });
    expect(response.action).toBeNull();
    expect(response.recovery?.code).toBe("awaiting_recommendation");
  });

  test("treats a future fact as stale instead of current", async () => {
    const user = await authorizedUser();
    await profileFor(user.id);
    await syncedFact(user.id, "2026-07-12", 1);
    const response = await today.get(user.id, "future", new Date("2026-07-11T08:00:00.000Z"));
    expect(response.state).toBe("stale_data");
    expect(response.freshness).toMatchObject({ status: "stale", latest_local_date: "2026-07-12" });
    expect(response.action).toBeNull();
  });

  test("projects exactly one published action with stable cache identity and no raw health values", async () => {
    const fixture = await publishedToday();
    const first = await today.get(fixture.user.id, "correlation-a", new Date("2026-07-11T08:00:00.000Z"));
    const second = await today.get(fixture.user.id, "correlation-b", new Date("2026-07-11T09:00:00.000Z"));
    expect(first.state).toBe("active_action");
    expect(first.action).toEqual({
      id: fixture.manifest.actionAssignmentId!,
      code: "SLEEP_WIND_DOWN",
      status: "active",
      duration_minutes: 10,
      difficulty: "standard",
      reason_key: "reason.action_selected",
      signal_key: "signal.sleep_recovery",
      commands: { complete: true, lighter: true, swap: true, skip: true, why: true },
    });
    expect(first.recovery).toBeNull();
    expect(second.cache_identity).toBe(first.cache_identity);
    expect(second.correlation_id).toBe("correlation-b");
    expect(JSON.stringify(first)).not.toContain("6400");
  });

  test("never leaks another user's publication", async () => {
    const fixture = await publishedToday();
    const other = await authorizedUser();
    await profileFor(other.id);
    const response = await today.get(other.id, "correlation-other", new Date("2026-07-11T08:00:00.000Z"));
    expect(response.state).toBe("first_launch");
    expect(response.action).toBeNull();
    expect(JSON.stringify(response)).not.toContain(fixture.snapshot.id);
  });

  test.each(["completed", "rejected", "expired"] as const)(
    "turns %s action status into one recovery state and changes cache identity",
    async (status) => {
    const fixture = await publishedToday();
    const before = await today.get(fixture.user.id, "before", new Date("2026-07-11T08:00:00.000Z"));
    await database.actionAssignment.update({
      where: { id: fixture.manifest.actionAssignmentId! },
      data: { status },
    });
    const after = await today.get(fixture.user.id, "after", new Date("2026-07-11T08:00:00.000Z"));
    expect(after.state).toBe(`action_${status}`);
    expect(after.action).toBeNull();
    expect(after.recovery?.code).toBe(`action_${status}`);
    expect(after.cache_identity).not.toBe(before.cache_identity);
    },
  );

  test("fails closed for stale data, a newer profile, and a later exact-rule incident", async () => {
    const stale = await publishedToday({ factDate: "2026-07-01" });
    await syncedFact(stale.user.id, "2026-07-11", 1, "hrv_ms");
    expect((await today.get(stale.user.id, "stale", new Date("2026-07-11T08:00:00.000Z"))).state)
      .toBe("stale_data");

    await database.$executeRawUnsafe(`
      TRUNCATE TABLE users, rule_bundles, audit_logs, privacy_reconciliation
      RESTART IDENTITY CASCADE
    `);
    await database.privacyReconciliation.create({ data: { id: "global", status: "ready" } });
    const changed = await publishedToday();
    await profileFor(changed.user.id, 2);
    expect((await today.get(changed.user.id, "changed", new Date("2026-07-11T08:00:00.000Z"))).state)
      .toBe("profile_changed");

    await database.$executeRawUnsafe(`
      TRUNCATE TABLE users, rule_bundles, audit_logs, privacy_reconciliation
      RESTART IDENTITY CASCADE
    `);
    await database.privacyReconciliation.create({ data: { id: "global", status: "ready" } });
    const withdrawn = await publishedToday();
    await database.safetyIncident.create({
      data: {
        userId: withdrawn.user.id,
        source: "rule:sleep_recovery:SLEEP_WIND_DOWN",
        severity: "high",
        detailsEncrypted: "synthetic-ciphertext",
      },
    });
    const response = await today.get(withdrawn.user.id, "incident", new Date("2026-07-11T08:00:00.000Z"));
    expect(response.state).toBe("recommendation_withdrawn");
    expect(response.action).toBeNull();
  });

  test.each([
    ["old consent epoch", { consentEpoch: 0 }],
    ["missing sync", { omitSync: true }],
    ["pending sync", { status: "pending", completedAt: null }],
    ["failed sync", { status: "failed", completedAt: null }],
    ["cross-user sync", { crossUserSync: true }],
    ["mismatched server sequence", { serverSequenceOffset: 1n }],
  ] satisfies Array<[string, SyntheticSyncOptions]>) (
    "withdraws a published action backed by %s evidence",
    async (_label, sync) => {
      const fixture = await publishedToday({ sync });
      const response = await today.get(
        fixture.user.id,
        randomUUID(),
        new Date("2026-07-11T08:00:00.000Z"),
      );
      expect(response.state).toBe("recommendation_withdrawn");
      expect(response.action).toBeNull();
      expect(response.recovery?.code).toBe("recommendation_withdrawn");
    },
  );

  test("rejects rewriting an old sync into the publication consent epoch", async () => {
    const fixture = await publishedToday();
    const syncId = fixture.fact.healthSyncRunId!;
    await expect(database.healthSyncRun.update({
      where: { id: syncId },
      data: { consentEpoch: 2 },
    })).rejects.toThrow(/immutable|health sync/i);

    const response = await today.get(
      fixture.user.id,
      randomUUID(),
      new Date("2026-07-11T08:00:00.000Z"),
    );
    expect(response.state).toBe("active_action");
  });

  test("never revives a recommendation whose sync completed after the run was created", async () => {
    const fixture = await publishedToday({
      sync: { status: "pending", completedAt: null },
    });
    await database.healthSyncRun.update({
      where: { id: fixture.fact.healthSyncRunId! },
      data: {
        status: "completed",
        completedAt: new Date(fixture.run.createdAt.getTime() + 1_000),
      },
    });

    const response = await today.get(
      fixture.user.id,
      randomUUID(),
      new Date("2026-07-11T08:00:00.000Z"),
    );
    expect(response.state).toBe("recommendation_withdrawn");
    expect(response.action).toBeNull();
  });

  test("protects the HTTP route and honors ETag conditional reads", async () => {
    const currentLocalDate = shanghaiDate(new Date());
    const fixture = await publishedToday({ localDate: currentLocalDate, factDate: currentLocalDate });
    const unauthorized = await app.inject({ method: "GET", url: "/today" });
    expect(unauthorized.statusCode).toBe(401);

    const sessions = app.get(SessionService);
    const tokens = await sessions.issue(fixture.user.id);
    const firstCorrelation = randomUUID();
    const first = await app.inject({
      method: "GET",
      url: "/today",
      headers: { authorization: `Bearer ${tokens.accessToken}`, "x-correlation-id": firstCorrelation },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ state: "active_action", action: { code: "SLEEP_WIND_DOWN" } });
    expect(first.headers["cache-control"]).toBe("private, no-cache");
    expect(first.headers["x-correlation-id"]).toBe(firstCorrelation);
    const etag = first.headers.etag;
    expect(etag).toMatch(/^W\/"[a-f0-9]{64}"$/);

    const unchangedCorrelation = randomUUID();
    const unchanged = await app.inject({
      method: "GET",
      url: "/today",
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        "if-none-match": etag!,
        "x-correlation-id": unchangedCorrelation,
      },
    });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.body).toBe("");
    expect(unchanged.headers["x-correlation-id"]).toBe(unchangedCorrelation);

    const listMatch = await app.inject({
      method: "GET",
      url: "/today",
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        "if-none-match": `"unrelated", ${etag}`,
        "x-correlation-id": randomUUID(),
      },
    });
    expect(listMatch.statusCode).toBe(304);
  });
});
