import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { after, afterEach, before } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import type { RuleInput } from "@healthos/rules";
import { PrismaClient, type Prisma } from "@prisma/client";

import {
  deriveSignalProjections,
  minimumSourceCoverage,
  SignalProjectionWorker,
} from "./signal-projection-worker";
import { SignalProjectionDispatcher } from "./signal-projection-dispatcher";

const base: RuleInput = {
  age_group: "adult",
  pregnancy_state: "none",
  serious_conditions: [],
  diabetes_treatment: false,
  medication_affects_advice: false,
  eating_disorder_risk: false,
  acute_symptoms: false,
  mobility_limited: false,
  freshness: "current",
  signals: {
    sleep_recovery: "normal",
    fatty_liver: "elevated",
    uric_acid: "unknown",
  },
  rejected_action_codes: [],
};

const database = new PrismaClient();
const runtimeImport = new Function("specifier", "return import(specifier)") as
  (specifier: string) => Promise<Record<string, new (...arguments_: unknown[]) => unknown>>;
interface BundleRecord { id: string; bundleDigest: string | null }
let bundles: {
  create(version: string, content: Record<string, unknown>): Promise<BundleRecord>;
  approve(id: string, input: { role: string; actorId: string; approvedAt: Date }): Promise<BundleRecord>;
  activate(id: string, actorId: string, autoPublish: boolean): Promise<BundleRecord>;
};
let runs: {
  request(input: Record<string, unknown>): Promise<{ id: string }>;
};
let publication: {
  publishReviewed(input: Record<string, unknown>): Promise<{ snapshot: { id: string; snapshotHash: string | null } }>;
};

function runtimeExport(
  module: Record<string, new (...arguments_: unknown[]) => unknown>,
  name: string,
): (new (...arguments_: unknown[]) => unknown) | undefined {
  if (module[name]) return module[name];
  const fallback = module.default as unknown as Record<string, new (...arguments_: unknown[]) => unknown> | undefined;
  return fallback?.[name];
}

before(async () => {
  await database.$connect();
  const apiRoot = path.resolve(process.cwd(), "../api/src");
  const modules = await Promise.all([
    runtimeImport(pathToFileURL(path.join(apiRoot, "recommendations/rule-bundle.service.ts")).href),
    runtimeImport(pathToFileURL(path.join(apiRoot, "recommendations/recommendation-run.service.ts")).href),
    runtimeImport(pathToFileURL(path.join(apiRoot, "database/publication.repository.ts")).href),
  ]);
  const RuleBundleService = modules[0] ? runtimeExport(modules[0], "RuleBundleService") : undefined;
  const RecommendationRunService = modules[1] ? runtimeExport(modules[1], "RecommendationRunService") : undefined;
  const PublicationRepository = modules[2] ? runtimeExport(modules[2], "PublicationRepository") : undefined;
  if (!RuleBundleService || !RecommendationRunService || !PublicationRepository) {
    throw new Error("Signal integration harness services are unavailable");
  }
  bundles = new RuleBundleService(database) as typeof bundles;
  runs = new RecommendationRunService(database) as typeof runs;
  publication = new PublicationRepository(database) as typeof publication;
});

after(async () => database.$disconnect());
afterEach(async () => {
  await database.$executeRawUnsafe(`
    TRUNCATE TABLE users, rule_bundles, audit_logs, privacy_reconciliation
    RESTART IDENTITY CASCADE
  `);
  await database.privacyReconciliation.create({ data: { id: "global", status: "ready" } });
});

async function publishedFixture(ruleInput: RuleInput = base, coverage: number | null = 0.75) {
  const bundleNonce = randomUUID();
  const user = await database.user.create({ data: { consentEpoch: 1 } });
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
  const draftBundle = await bundles.create(`synthetic-signals-${bundleNonce}`, {
    rules_engine: "deterministic-rules-v1",
    rules_engine_digest: "22e19a3848877f16f3a56921f91f8eb1f3a54f21551d3c47569153f748c8d282",
    safety_bundle_digest: "1".repeat(64), localization_bundle_digest: "2".repeat(64),
    template_bundle_digest: "3".repeat(64), beta_normal_review_percent: 20,
    rules: [{ code: `synthetic-signals-${bundleNonce}` }],
  });
  await bundles.approve(draftBundle.id, { role: "technical", actorId: `tech-${draftBundle.id}`, approvedAt: new Date() });
  await bundles.approve(draftBundle.id, { role: "medical", actorId: `medical-${draftBundle.id}`, approvedAt: new Date() });
  const bundle = await bundles.activate(draftBundle.id, "synthetic-release", false);
  const sync = await database.healthSyncRun.create({ data: {
    userId: user.id, deviceId: `signals-${randomUUID()}`, anchorEpoch: 1, idempotencyKey: randomUUID(),
    requestHash: randomBytes(32).toString("hex"), timezone: "Asia/Shanghai", consentEpoch: 1,
    status: "completed", completedAt: new Date("2026-07-11T00:01:00Z"), correlationId: randomUUID(),
  } });
  const fact = await database.dailyHealthFactRevision.create({ data: {
    userId: user.id, localDate: new Date("2026-07-11T00:00:00Z"), metric: "steps",
    canonicalValueJson: { value: 6000 }, coverage, sourceVectorJson: { synthetic: 1 },
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
    rules_engine_digest: "22e19a3848877f16f3a56921f91f8eb1f3a54f21551d3c47569153f748c8d282",
    safety_bundle: "1".repeat(64), localization_bundle: "2".repeat(64), template_bundle: "3".repeat(64),
    prompt_version: null, provider_id: null, model_id: null, rendered_payload_hash: "0".repeat(64),
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
    snapshotId: draft.id, priority: "normal", slaAt: new Date(Date.now() + 60_000), reasonCode: "SYNTHETIC_SIGNALS",
  } });
  const result = await publication.publishReviewed({
    draftSnapshotId: draft.id, actorId: "synthetic-signal-reviewer", reasonCode: "SYNTHETIC_APPROVAL",
  });
  return { bundle, fact, profile, snapshot: result.snapshot, user };
}

test("translates only validated rule semantics and source coverage", () => {
  const projections = deriveSignalProjections({
    ruleInput: base,
    minimumCoverage: 0.75,
    previousStates: { sleep_recovery: "watch", fatty_liver: "watch" },
    sourceFactRevisionIds: ["fact-a", "fact-b"],
  });

  assert.deepEqual(projections.map(({ signalCode, state, trend, freshness, confidence }) => ({
    signalCode, state, trend, freshness, confidence,
  })), [
    { signalCode: "sleep_recovery", state: "stable", trend: "improving", freshness: "partial", confidence: 0.75 },
    { signalCode: "fatty_liver", state: "watch", trend: "stable", freshness: "partial", confidence: 0.75 },
    { signalCode: "uric_acid", state: "unknown", trend: "unknown", freshness: "partial", confidence: 0 },
    { signalCode: "waist_weight", state: "unknown", trend: "unknown", freshness: "partial", confidence: 0 },
  ]);
  assert.equal(JSON.stringify(projections).includes("canonical_value"), false);
  assert.deepEqual(projections[0]?.drivers, [{
    code: "validated_rule_signal",
    source_fact_revision_ids: ["fact-a", "fact-b"],
  }]);
});

test("fails closed for stale, missing, and conflicting evidence", () => {
  for (const freshness of ["stale", "missing", "conflicting"] as const) {
    const [projection] = deriveSignalProjections({
      ruleInput: { ...base, freshness },
      minimumCoverage: 1,
      previousStates: {},
      sourceFactRevisionIds: [],
    });
    assert.equal(projection?.state, freshness === "stale" ? "stable" : "unknown");
    assert.equal(projection?.freshness, freshness === "stale" ? "stale" : "unknown");
    assert.equal(projection?.confidence, freshness === "stale" ? 1 : 0);
    assert.equal(projection?.trend, "unknown");
  }
});

test("treats any missing source coverage as zero confidence evidence", () => {
  assert.equal(minimumSourceCoverage([1, null]), 0);
  assert.equal(minimumSourceCoverage([1, 0.6]), 0.6);
  assert.equal(minimumSourceCoverage([]), 0);
});

test("projects one immutable idempotent set from a real published snapshot", async () => {
  const fixture = await publishedFixture();
  const worker = new SignalProjectionWorker(database);
  const first = await worker.project(fixture.snapshot.id);
  const replay = await worker.project(fixture.snapshot.id);
  assert.equal(first.length, 4);
  assert.deepEqual(replay.map((item) => item.id), first.map((item) => item.id));
  assert.equal(first.find((item) => item.signalCode === "sleep_recovery")?.state, "stable");
  assert.equal(first.find((item) => item.signalCode === "fatty_liver")?.state, "watch");
  assert.equal(first[0]?.sourceHash === "0".repeat(64), false);
  await assert.rejects(database.signalSnapshot.update({
    where: { id: first[0]!.id }, data: { state: "watch" },
  }), /append-only/i);
});

test("projects null source coverage as partial with zero confidence", async () => {
  const fixture = await publishedFixture(base, null);
  const rows = await new SignalProjectionWorker(database).project(fixture.snapshot.id);
  const sleep = rows.find((item) => item.signalCode === "sleep_recovery");
  assert.equal(sleep?.freshness, "partial");
  assert.equal(Number(sleep?.confidence), 0);
});

test("claims and consumes the production recommendation.published outbox exactly once", async () => {
  const fixture = await publishedFixture();
  const outbox = await database.domainOutbox.findFirstOrThrow({
    where: { eventType: "recommendation.published", aggregateId: fixture.snapshot.id },
  });
  const dispatcher = new SignalProjectionDispatcher(
    database,
    new SignalProjectionWorker(database),
    { leaseSeconds: 30, pollMilliseconds: 60_000 },
  );
  const lease = await dispatcher.claim(outbox.id);
  await dispatcher.process(outbox.id, lease.leaseToken ?? "missing");
  await dispatcher.process(outbox.id, lease.leaseToken ?? "missing");
  assert.equal(await database.signalSnapshot.count({
    where: { recommendationSnapshotId: fixture.snapshot.id },
  }), 4);
  assert.equal(await database.consumerInbox.count({
    where: { consumer: "signal-snapshot-projector-v1", messageId: outbox.id },
  }), 1);
  assert.equal((await database.domainOutbox.findUniqueOrThrow({ where: { id: outbox.id } })).status, "sent");
});

test("rejects changed authorization, safety incidents, and partial projection history", async () => {
  const consentFixture = await publishedFixture();
  await database.consentRecord.create({ data: {
    userId: consentFixture.user.id, consentType: "health_processing", documentVersion: "synthetic-v2",
    granted: false, epoch: 2, correlationId: randomUUID(), requestHash: randomUUID(), source: "synthetic",
  } });
  await assert.rejects(new SignalProjectionWorker(database).project(consentFixture.snapshot.id), /no longer current/i);

  await database.$executeRawUnsafe(`TRUNCATE TABLE users, rule_bundles, audit_logs, privacy_reconciliation RESTART IDENTITY CASCADE`);
  await database.privacyReconciliation.create({ data: { id: "global", status: "ready" } });
  const incidentFixture = await publishedFixture();
  await database.safetyIncident.create({ data: {
    userId: incidentFixture.user.id, source: "rule:sleep_recovery:SLEEP_WIND_DOWN",
    severity: "high", detailsEncrypted: "synthetic",
  } });
  await assert.rejects(new SignalProjectionWorker(database).project(incidentFixture.snapshot.id), /no longer current/i);

  await database.$executeRawUnsafe(`TRUNCATE TABLE users, rule_bundles, audit_logs, privacy_reconciliation RESTART IDENTITY CASCADE`);
  await database.privacyReconciliation.create({ data: { id: "global", status: "ready" } });
  const partialFixture = await publishedFixture();
  const partialDrivers = [{
    code: "validated_rule_signal",
    source_fact_revision_ids: [partialFixture.fact.id],
  }];
  const partialProvenance = {
    recommendation_snapshot_id: partialFixture.snapshot.id,
    recommendation_snapshot_hash: partialFixture.snapshot.snapshotHash,
    profile_snapshot_id: partialFixture.profile.id,
    profile_snapshot_hash: partialFixture.profile.snapshotHash,
    rule_bundle_id: partialFixture.bundle.id,
    rule_bundle_digest: partialFixture.bundle.bundleDigest,
    consent_epoch: 1,
    fact_revision_ids: [partialFixture.fact.id],
    fact_input_hashes: [partialFixture.fact.inputHash],
  };
  await database.signalSnapshot.create({ data: {
    userId: partialFixture.user.id, localDate: new Date("2026-07-11T00:00:00Z"),
    signalCode: "sleep_recovery", revision: 1, state: "stable", trend: "unknown",
    confidence: 0.75, freshness: "partial", driversJson: partialDrivers,
    provenanceJson: partialProvenance, sourceHash: "0".repeat(64),
    recommendationSnapshotId: partialFixture.snapshot.id,
  } });
  await assert.rejects(new SignalProjectionWorker(database).project(partialFixture.snapshot.id), /incomplete/i);
});

test("rechecks consent after waiting for a concurrent withdrawal transaction", async () => {
  const fixture = await publishedFixture();
  const withdrawalDatabase = new PrismaClient();
  await withdrawalDatabase.$connect();
  let releaseWithdrawal!: () => void;
  let withdrawalLocked!: () => void;
  const release = new Promise<void>((resolve) => { releaseWithdrawal = resolve; });
  const locked = new Promise<void>((resolve) => { withdrawalLocked = resolve; });
  const withdrawal = withdrawalDatabase.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${fixture.user.id}::uuid FOR UPDATE`;
    await tx.consentRecord.create({ data: {
      userId: fixture.user.id, consentType: "health_processing", documentVersion: "synthetic-race-v2",
      granted: false, epoch: 2, correlationId: randomUUID(), requestHash: randomUUID(), source: "synthetic",
    } });
    await tx.user.update({ where: { id: fixture.user.id }, data: { consentEpoch: 2 } });
    withdrawalLocked();
    await release;
  });

  try {
    await locked;
    const projection = new SignalProjectionWorker(database).project(fixture.snapshot.id);
    await sleep(100);
    releaseWithdrawal();
    await withdrawal;
    await assert.rejects(projection, /no longer current/i);
  } finally {
    releaseWithdrawal();
    await withdrawal.catch(() => undefined);
    await withdrawalDatabase.$disconnect();
  }
});

test("suppresses a permanently invalid head message and then consumes the next publication", async () => {
  const invalid = await publishedFixture();
  await database.consentRecord.create({ data: {
    userId: invalid.user.id, consentType: "health_processing", documentVersion: "synthetic-invalid-v2",
    granted: false, epoch: 2, correlationId: randomUUID(), requestHash: randomUUID(), source: "synthetic",
  } });
  await database.user.update({ where: { id: invalid.user.id }, data: { consentEpoch: 2 } });
  const valid = await publishedFixture();
  const invalidOutbox = await database.domainOutbox.findFirstOrThrow({
    where: { eventType: "recommendation.published", aggregateId: invalid.snapshot.id },
  });
  const validOutbox = await database.domainOutbox.findFirstOrThrow({
    where: { eventType: "recommendation.published", aggregateId: valid.snapshot.id },
  });
  await database.domainOutbox.update({
    where: { id: invalidOutbox.id }, data: { availableAt: new Date("2026-01-01T00:00:00Z") },
  });
  await database.domainOutbox.update({
    where: { id: validOutbox.id }, data: { availableAt: new Date("2026-01-02T00:00:00Z") },
  });
  const dispatcher = new SignalProjectionDispatcher(
    database,
    new SignalProjectionWorker(database),
    { leaseSeconds: 30, pollMilliseconds: 60_000 },
  );

  assert.equal(await dispatcher.drainOnce(), true);
  assert.equal((await database.domainOutbox.findUniqueOrThrow({ where: { id: invalidOutbox.id } })).status, "suppressed");
  assert.equal(await dispatcher.drainOnce(), true);
  assert.equal((await database.domainOutbox.findUniqueOrThrow({ where: { id: validOutbox.id } })).status, "sent");
  assert.equal(await database.signalSnapshot.count({
    where: { recommendationSnapshotId: valid.snapshot.id },
  }), 4);
});

test("retries a publication after privacy reconciliation becomes ready", async () => {
  const fixture = await publishedFixture();
  const outbox = await database.domainOutbox.findFirstOrThrow({
    where: { eventType: "recommendation.published", aggregateId: fixture.snapshot.id },
  });
  await database.privacyReconciliation.update({
    where: { id: "global" }, data: { status: "running" },
  });
  const dispatcher = new SignalProjectionDispatcher(
    database,
    new SignalProjectionWorker(database),
    { leaseSeconds: 30, pollMilliseconds: 60_000 },
  );

  await assert.rejects(dispatcher.drainOnce(), /temporarily unavailable/i);
  assert.equal((await database.domainOutbox.findUniqueOrThrow({ where: { id: outbox.id } })).status, "failed");
  await database.privacyReconciliation.update({
    where: { id: "global" }, data: { status: "ready" },
  });
  assert.equal(await dispatcher.drainOnce(), true);
  assert.equal((await database.domainOutbox.findUniqueOrThrow({ where: { id: outbox.id } })).status, "sent");
  assert.equal(await database.signalSnapshot.count({
    where: { recommendationSnapshotId: fixture.snapshot.id },
  }), 4);
});

test("waits for an active scheduled drain during shutdown", async () => {
  const dispatcher = new SignalProjectionDispatcher(
    {} as PrismaClient,
    {} as SignalProjectionWorker,
    { leaseSeconds: 30, pollMilliseconds: 60_000 },
  );
  let drainStarted!: () => void;
  let releaseDrain!: () => void;
  const started = new Promise<void>((resolve) => { drainStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseDrain = resolve; });
  dispatcher.drainOnce = async () => {
    drainStarted();
    await release;
    return true;
  };
  const previousNodeEnv = process.env.NODE_ENV;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.NODE_ENV = "production";
  process.env.DATABASE_URL = "synthetic://shutdown";

  try {
    dispatcher.onApplicationBootstrap();
    await started;
    let settled = false;
    const shutdown = Promise.resolve(dispatcher.onApplicationShutdown()).then(() => { settled = true; });
    await sleep(20);
    assert.equal(settled, false);
    releaseDrain();
    await shutdown;
    assert.equal(settled, true);
  } finally {
    releaseDrain();
    process.env.NODE_ENV = previousNodeEnv;
    process.env.DATABASE_URL = previousDatabaseUrl;
  }
});
