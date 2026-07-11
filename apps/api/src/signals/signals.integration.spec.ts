import { randomBytes, randomUUID } from "node:crypto";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { RuleInput } from "@healthos/rules";
import type { Prisma } from "@prisma/client";

import { createApp } from "../main";
import { DatabaseService } from "../database/prisma.service";
import { PublicationRepository } from "../database/publication.repository";
import { SessionService } from "../identity/session.service";
import { RecommendationRunService } from "../recommendations/recommendation-run.service";
import { RULES_ENGINE_ARTIFACT_DIGEST, RuleBundleService } from "../recommendations/rule-bundle.service";
import { SignalsService } from "./signals.service";

const ruleInput: RuleInput = {
  age_group: "adult", pregnancy_state: "none", serious_conditions: [], diabetes_treatment: false,
  medication_affects_advice: false, eating_disorder_risk: false, acute_symptoms: false,
  mobility_limited: false, freshness: "current",
  signals: { sleep_recovery: "elevated", fatty_liver: "normal" }, rejected_action_codes: [],
};

describe("Map signals API", () => {
  const database = new DatabaseService();
  const bundles = new RuleBundleService(database);
  const runs = new RecommendationRunService(database);
  const publication = new PublicationRepository(database);
  const signals = new SignalsService(database);
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env.APPLE_CLIENT_ID = "synthetic.signals.client";
    process.env.SESSION_SIGNING_SECRET = "synthetic-signals-session-secret-32-characters";
    process.env.APPLE_SUBJECT_HASH_KEY = "synthetic-signals-subject-hash-key";
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

  async function fixture() {
    const user = await database.user.create({ data: { consentEpoch: 1, timezone: "Asia/Shanghai" } });
    await database.consentRecord.create({ data: {
      userId: user.id, consentType: "health_processing", documentVersion: "synthetic-signals-v1",
      granted: true, epoch: 1, correlationId: randomUUID(), requestHash: randomUUID(), source: "synthetic",
    } });
    const event = await database.profileEvent.create({ data: {
      userId: user.id, consentEpoch: 1, eventType: "synthetic_profile_created", source: "synthetic",
      payload: {}, payloadHash: randomBytes(32).toString("hex"), correlationId: randomUUID(),
    } });
    const profile = await database.profileSnapshot.create({ data: {
      userId: user.id, version: 1, consentEpoch: 1,
      factsJson: { rule_input: ruleInput } as unknown as Prisma.InputJsonObject,
      sourceEventUntil: event.id, sourceSequence: event.sequence, snapshotHash: randomBytes(32).toString("hex"),
    } });
    const draftBundle = await bundles.create(`synthetic-map-${randomUUID()}`, {
      rules_engine: "deterministic-rules-v1", rules_engine_digest: RULES_ENGINE_ARTIFACT_DIGEST,
      safety_bundle_digest: "1".repeat(64), localization_bundle_digest: "2".repeat(64),
      template_bundle_digest: "3".repeat(64), beta_normal_review_percent: 20,
      rules: [{ code: "synthetic-map" }],
    });
    await bundles.approve(draftBundle.id, { role: "technical", actorId: `tech-${draftBundle.id}`, approvedAt: new Date() });
    await bundles.approve(draftBundle.id, { role: "medical", actorId: `medical-${draftBundle.id}`, approvedAt: new Date() });
    const bundle = await bundles.activate(draftBundle.id, "synthetic-release", false);
    const sync = await database.healthSyncRun.create({ data: {
      userId: user.id, deviceId: `map-${randomUUID()}`, anchorEpoch: 1, idempotencyKey: randomUUID(),
      requestHash: randomBytes(32).toString("hex"), timezone: "Asia/Shanghai", consentEpoch: 1,
      status: "completed", completedAt: new Date("2026-07-11T00:01:00Z"), correlationId: randomUUID(),
    } });
    const fact = await database.dailyHealthFactRevision.create({ data: {
      userId: user.id, localDate: new Date("2026-07-11T00:00:00Z"), metric: "steps",
      canonicalValueJson: { value: 987654 }, coverage: 0.8, sourceVectorJson: { synthetic: 1 },
      inputHash: randomBytes(32).toString("hex"), healthSyncRunId: sync.id, serverSequence: sync.serverSequence,
    } });
    const run = await runs.request({
      userId: user.id, localDate: "2026-07-11", profileSnapshotId: profile.id, ruleInput,
      factRevisionIds: [fact.id], labObservationIds: [], correlationId: randomUUID(),
    });
    await database.recommendationRun.update({ where: { id: run.id }, data: { status: "completed" } });
    const provenance = {
      profile_snapshot_id: profile.id, profile_snapshot_hash: profile.snapshotHash,
      daily_fact_revision_ids: [fact.id], daily_fact_input_hashes: [fact.inputHash],
      lab_observation_ids: [], lab_observation_hashes: [], rule_bundle_id: bundle.id,
      rule_bundle_digest: bundle.bundleDigest, rules_engine: "deterministic-rules-v1",
      rules_engine_digest: RULES_ENGINE_ARTIFACT_DIGEST, safety_bundle: "1".repeat(64),
      localization_bundle: "2".repeat(64), template_bundle: "3".repeat(64), prompt_version: null,
      provider_id: null, model_id: null, rendered_payload_hash: "0".repeat(64),
      generated_at: "2026-07-11T01:00:00Z", rule_key: "sleep_recovery:SLEEP_WIND_DOWN",
      rule_result: { outcome: "action", safetyClass: "normal", riskArea: "sleep_recovery", actionCode: "SLEEP_WIND_DOWN" },
    };
    const draft = await database.recommendationSnapshot.create({ data: {
      runId: run.id, revision: 1, riskArea: "sleep_recovery", safetyClass: "normal",
      actionCode: "SLEEP_WIND_DOWN", renderedPayloadJson: {
        template: "daily_action_v1", action_code: "SLEEP_WIND_DOWN", safety_class: "normal", risk_area: "sleep_recovery",
      }, canonicalRuleInputJson: ruleInput as unknown as Prisma.InputJsonObject, provenanceJson: provenance,
      reviewStatus: "review_required", releaseStage: "alpha", reviewRoute: "review_required",
      policyDigest: "5".repeat(64), reviewSamplePercent: 20,
    } });
    await database.recommendationReviewEvent.create({ data: { snapshotId: draft.id, eventType: "submitted" } });
    await database.recommendationReviewTask.create({ data: {
      snapshotId: draft.id, priority: "normal", slaAt: new Date(Date.now() + 60_000), reasonCode: "SYNTHETIC_MAP",
    } });
    const published = await publication.publishReviewed({
      draftSnapshotId: draft.id, actorId: "synthetic-map-reviewer", reasonCode: "SYNTHETIC_APPROVAL",
    });
    const action = await database.actionAssignment.findUniqueOrThrow({
      where: { id: published.manifest.actionAssignmentId! },
    });
    const signalDrivers = [{ code: "validated_rule_signal", source_fact_revision_ids: [fact.id] }];
    const signalProvenance = {
      recommendation_snapshot_id: published.snapshot.id,
      recommendation_snapshot_hash: published.snapshot.snapshotHash,
      profile_snapshot_id: profile.id,
      profile_snapshot_hash: profile.snapshotHash,
      rule_bundle_id: bundle.id,
      rule_bundle_digest: bundle.bundleDigest,
      consent_epoch: 1,
      fact_revision_ids: [fact.id],
      fact_input_hashes: [fact.inputHash],
    };
    const rows = await Promise.all([
      ["sleep_recovery", "watch", "unknown", 0.8],
      ["fatty_liver", "stable", "unknown", 0.8],
    ].map(([signalCode, state, trend, confidence]) => database.signalSnapshot.create({ data: {
      userId: user.id, localDate: new Date("2026-07-11T00:00:00Z"), signalCode: String(signalCode),
      revision: 1, state: String(state), trend: String(trend), confidence: Number(confidence), freshness: "partial",
      driversJson: signalDrivers,
      provenanceJson: signalProvenance,
      sourceHash: "0".repeat(64), recommendationSnapshotId: published.snapshot.id,
    } })));
    return { action, bundle, fact, profile, rows, signalDrivers, signalProvenance, snapshot: published.snapshot, user };
  }

  test("protects the route, validates selection, and returns a redacted current-user Map", async () => {
    const data = await fixture();
    expect((await app.inject({ method: "GET", url: "/map" })).statusCode).toBe(401);
    const token = await app.get(SessionService).issue(data.user.id);
    expect((await app.inject({ method: "GET", url: "/map?selected=unsupported", headers: {
      authorization: `Bearer ${token.accessToken}`,
    } })).statusCode).toBe(400);
    const response = await app.inject({ method: "GET", url: "/map?selected=sleep_recovery", headers: {
      authorization: `Bearer ${token.accessToken}`,
    } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      schema_version: 1, local_date: "2026-07-11",
      selected: { code: "sleep_recovery", today_action_link: { id: data.action.id, code: "SLEEP_WIND_DOWN" } },
    });
    expect(response.json().signals).toHaveLength(2);
    expect(response.body).not.toContain(data.fact.id);
    expect(response.body).not.toContain("987654");
  });

  test("fails closed for another user, withdrawn consent, incidents, and terminal actions", async () => {
    const data = await fixture();
    const other = await database.user.create({ data: { consentEpoch: 1 } });
    await database.consentRecord.create({ data: {
      userId: other.id, consentType: "health_processing", documentVersion: "synthetic-v1", granted: true,
      epoch: 1, correlationId: randomUUID(), requestHash: randomUUID(), source: "synthetic",
    } });
    expect((await signals.get(other.id, "sleep_recovery", new Date("2026-07-11T08:00:00Z"))).signals).toEqual([]);
    await database.actionAssignment.update({
      where: { id: data.action.id }, data: { status: "completed", version: { increment: 1 } },
    });
    expect((await signals.get(data.user.id, "sleep_recovery", new Date("2026-07-11T08:00:00Z"))).selected?.today_action_link).toBeNull();
    await database.safetyIncident.create({ data: {
      userId: data.user.id, source: "rule:sleep_recovery:SLEEP_WIND_DOWN", severity: "high", detailsEncrypted: "synthetic",
    } });
    expect((await signals.get(data.user.id, "sleep_recovery", new Date("2026-07-11T08:00:00Z"))).signals).toEqual([]);
    await database.consentRecord.create({ data: {
      userId: data.user.id, consentType: "health_processing", documentVersion: "synthetic-v2", granted: false,
      epoch: 2, correlationId: randomUUID(), requestHash: randomUUID(), source: "synthetic",
    } });
    await expect(signals.get(data.user.id, undefined, new Date("2026-07-11T08:00:00Z"))).rejects.toThrow(/authorization/i);
  });

  test("enforces semantic provenance, append-only history, and exact privacy deletion", async () => {
    const data = await fixture();
    await expect(database.signalSnapshot.create({ data: {
      userId: data.user.id, localDate: new Date("2026-07-11T00:00:00Z"), signalCode: "uric_acid",
      revision: 1, state: "diagnosis", trend: "stable", confidence: 1, freshness: "current",
      driversJson: data.signalDrivers, provenanceJson: data.signalProvenance, sourceHash: "0".repeat(64),
      recommendationSnapshotId: data.snapshot.id,
    } })).rejects.toThrow(/semantic/i);
    await expect(database.signalSnapshot.create({ data: {
      userId: data.user.id, localDate: new Date("2026-07-11T00:00:00Z"), signalCode: "uric_acid",
      revision: 1, state: "watch", trend: "unknown", confidence: 0.8, freshness: "partial",
      driversJson: data.signalDrivers, provenanceJson: data.signalProvenance, sourceHash: "0".repeat(64),
      recommendationSnapshotId: data.snapshot.id,
    } })).rejects.toThrow(/canonical published evidence/i);
    await expect(database.signalSnapshot.create({ data: {
      userId: data.user.id, localDate: new Date("2026-07-11T00:00:00Z"), signalCode: "uric_acid",
      revision: 3, state: "unknown", trend: "unknown", confidence: 0, freshness: "partial",
      driversJson: data.signalDrivers, provenanceJson: data.signalProvenance, sourceHash: "0".repeat(64),
      recommendationSnapshotId: data.snapshot.id,
    } })).rejects.toThrow(/revision/i);
    await expect(database.signalSnapshot.update({
      where: { id: data.rows[0]!.id }, data: { confidence: 0.1 },
    })).rejects.toThrow(/append-only/i);
    await database.user.update({
      where: { id: data.user.id }, data: { status: "deleting", deletedAt: new Date() },
    });
    await database.$queryRaw`SELECT "healthos_delete_frozen_user"(${data.user.id}::uuid)`;
    await expect(database.signalSnapshot.count({ where: { userId: data.user.id } })).resolves.toBe(0);
  });

  test("rejects a canonical signal insert after its rule bundle is superseded", async () => {
    const data = await fixture();
    const successorNonce = randomUUID();
    const successorDraft = await bundles.create(`synthetic-map-successor-${successorNonce}`, {
      rules_engine: "deterministic-rules-v1", rules_engine_digest: RULES_ENGINE_ARTIFACT_DIGEST,
      safety_bundle_digest: "1".repeat(64), localization_bundle_digest: "2".repeat(64),
      template_bundle_digest: "3".repeat(64), beta_normal_review_percent: 20,
      rules: [{ code: `synthetic-map-successor-${successorNonce}` }],
    });
    await bundles.approve(successorDraft.id, {
      role: "technical", actorId: `tech-${successorDraft.id}`, approvedAt: new Date(),
    });
    await bundles.approve(successorDraft.id, {
      role: "medical", actorId: `medical-${successorDraft.id}`, approvedAt: new Date(),
    });
    await bundles.activate(successorDraft.id, "synthetic-successor-release", false);
    const canonical = {
      userId: data.user.id,
      localDate: new Date("2026-07-11T00:00:00Z"),
      signalCode: "uric_acid",
      revision: 1,
      state: "unknown",
      trend: "unknown",
      confidence: 0,
      freshness: "partial",
      driversJson: data.signalDrivers,
      provenanceJson: data.signalProvenance,
      sourceHash: "0".repeat(64),
      recommendationSnapshotId: data.snapshot.id,
    };

    await expect(database.signalSnapshot.create({ data: canonical })).rejects.toThrow(/bundle/i);
  });

  test("rejects a canonical signal insert after a matching safety incident", async () => {
    const data = await fixture();
    await database.safetyIncident.create({ data: {
      userId: data.user.id,
      source: "rule:sleep_recovery:SLEEP_WIND_DOWN",
      severity: "high",
      detailsEncrypted: "synthetic",
    } });
    await expect(database.signalSnapshot.create({ data: {
      userId: data.user.id,
      localDate: new Date("2026-07-11T00:00:00Z"),
      signalCode: "waist_weight",
      revision: 1,
      state: "unknown",
      trend: "unknown",
      confidence: 0,
      freshness: "partial",
      driversJson: data.signalDrivers,
      provenanceJson: data.signalProvenance,
      sourceHash: "0".repeat(64),
      recommendationSnapshotId: data.snapshot.id,
    } })).rejects.toThrow(/safety/i);
  });
});
