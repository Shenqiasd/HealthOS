import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, test } from "node:test";

import { Prisma, PrismaClient } from "@prisma/client";

import {
  RecommendationWorker,
  RULES_ENGINE_ARTIFACT_DIGEST,
  type RecommendationWorkerPolicy,
} from "./recommendation-worker";

const database = new PrismaClient();
const alphaPolicy: RecommendationWorkerPolicy = {
  releaseStage: "alpha",
  normalSamplePercent: 20,
  llmEnabled: false,
  leaseSeconds: 30,
  reviewSlaSeconds: 3600,
};

before(async () => {
  await database.$connect();
  await database.privacyReconciliation.update({ where: { id: "global" }, data: { status: "ready" } });
});
after(async () => database.$disconnect());
afterEach(async () => {
  await database.$executeRawUnsafe(`
    TRUNCATE TABLE users, rule_bundles, audit_logs, privacy_reconciliation
    RESTART IDENTITY CASCADE
  `);
  await database.privacyReconciliation.create({ data: { id: "global", status: "ready" } });
});

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

async function activeBundle(autoPublishEligible: boolean, qualifyRule = autoPublishEligible) {
  const bundle = await database.ruleBundle.create({
    data: {
      version: `synthetic-${randomUUID()}`,
      contentJson: {
        rules_engine: "deterministic-rules-v1",
        rules_engine_digest: RULES_ENGINE_ARTIFACT_DIGEST,
        safety_bundle_digest: "1".repeat(64),
        localization_bundle_digest: "2".repeat(64),
        template_bundle_digest: "3".repeat(64),
        beta_normal_review_percent: 20,
        rules: [{ code: "synthetic-rule" }],
      },
      contentHash: "0".repeat(64),
      bundleDigest: "0".repeat(64),
    },
  });
  await database.ruleBundleApproval.create({
    data: { ruleBundleId: bundle.id, role: "technical", actorId: "synthetic-tech", normalizedActor: "ignored", bundleDigest: bundle.bundleDigest!, approvedAt: new Date() },
  });
  await database.ruleBundleApproval.create({
    data: { ruleBundleId: bundle.id, role: "medical", actorId: "synthetic-medical", normalizedActor: "ignored", bundleDigest: bundle.bundleDigest!, approvedAt: new Date() },
  });
  const active = await database.ruleBundle.update({
    where: { id: bundle.id },
    data: { status: "active", autoPublishEligible, publishedBy: "synthetic-release", publishedAt: new Date() },
  });
  if (qualifyRule) await seedApprovalEvidence(active.id);
  return active;
}

async function seedApprovalEvidence(ruleBundleId: string) {
  await database.$transaction(async (tx) => {
    const qualificationBundle = await tx.ruleBundle.findUniqueOrThrow({ where: { id: ruleBundleId } });
    const user = await tx.user.create({ data: { consentEpoch: 1 } });
    await tx.consentRecord.create({
      data: {
        userId: user.id,
        consentType: "health_processing",
        documentVersion: "synthetic-qualification-v1",
        granted: true,
        epoch: 1,
        correlationId: randomUUID(),
        requestHash: randomUUID(),
        source: "synthetic",
      },
    });
    const event = await tx.profileEvent.create({
      data: {
        userId: user.id,
        eventType: "synthetic_profile_created",
        source: "synthetic",
        payload: {},
        correlationId: randomUUID(),
      },
    });
    const profile = await tx.profileSnapshot.create({
      data: {
        userId: user.id,
        version: 1,
        factsJson: { rule_input: baseRuleInput },
        sourceEventUntil: event.id,
        sourceSequence: event.sequence,
        consentEpoch: 1,
        snapshotHash: "9".repeat(64),
      },
    });
    for (let index = 0; index < 100; index += 1) {
      const localDate = new Date(Date.UTC(2025, 0, index + 1));
      const manifest = {
        profile_snapshot_id: profile.id,
        profile_snapshot_hash: profile.snapshotHash,
        consent_epoch: 1,
        rule_input: baseRuleInput,
        fact_inputs: [],
        lab_inputs: [],
        rule_bundle_id: ruleBundleId,
        rule_bundle_digest: qualificationBundle.bundleDigest,
      };
      const run = await tx.recommendationRun.create({
        data: {
          userId: user.id,
          localDate,
          inputSnapshotId: profile.id,
          ruleBundleId,
          consentEpoch: 1,
          inputHash: "0".repeat(64),
          inputManifestJson: manifest,
          status: "completed",
          correlationId: randomUUID(),
        },
      });
      const provenance = {
        profile_snapshot_id: profile.id,
        profile_snapshot_hash: profile.snapshotHash,
        daily_fact_revision_ids: [],
        daily_fact_input_hashes: [],
        lab_observation_ids: [],
        lab_observation_hashes: [],
        rule_bundle_id: qualificationBundle.id,
        rule_bundle_digest: qualificationBundle.bundleDigest,
        rules_engine: "deterministic-rules-v1",
        rules_engine_digest: RULES_ENGINE_ARTIFACT_DIGEST,
        safety_bundle: "1".repeat(64),
        localization_bundle: "2".repeat(64),
        template_bundle: "3".repeat(64),
        prompt_version: null,
        provider_id: null,
        model_id: null,
        rendered_payload_hash: "0".repeat(64),
        generated_at: new Date().toISOString(),
        rule_key: "sleep_recovery:SLEEP_WIND_DOWN",
        rule_result: {
          outcome: "action",
          safetyClass: "normal",
          actionCode: "SLEEP_WIND_DOWN",
          riskArea: "sleep_recovery",
          reasonCode: "ACTION_SELECTED",
        },
      };
      const renderedPayload = {
        template: "daily_action_v1",
        action_code: "SLEEP_WIND_DOWN",
        safety_class: "normal",
        risk_area: "sleep_recovery",
      };
      const draft = await tx.recommendationSnapshot.create({
        data: {
          runId: run.id,
          revision: 1,
          riskArea: "sleep_recovery",
          safetyClass: "normal",
          actionCode: "SLEEP_WIND_DOWN",
          renderedPayloadJson: renderedPayload,
          canonicalRuleInputJson: baseRuleInput,
          provenanceJson: provenance,
          reviewStatus: "review_required",
          releaseStage: "alpha",
          reviewRoute: "review_required",
          policyDigest: "8".repeat(64),
        },
      });
      const approved = await tx.recommendationSnapshot.create({
        data: {
          runId: run.id,
          revision: 2,
          supersedesId: draft.id,
          riskArea: "sleep_recovery",
          safetyClass: "normal",
          actionCode: "SLEEP_WIND_DOWN",
          renderedPayloadJson: renderedPayload,
          canonicalRuleInputJson: baseRuleInput,
          provenanceJson: provenance,
          reviewStatus: "published",
          releaseStage: "alpha",
          reviewRoute: "review_required",
          policyDigest: "8".repeat(64),
        },
      });
      const task = await tx.recommendationReviewTask.create({
        data: {
          snapshotId: draft.id,
          priority: "normal",
          slaAt: new Date(Date.now() + 3_600_000),
          reasonCode: "SYNTHETIC_RULE_QUALIFICATION",
        },
      });
      await tx.recommendationReviewTask.update({ where: { id: task.id }, data: { status: "completed" } });
      await tx.recommendationReviewEvent.create({
        data: {
          snapshotId: approved.id,
          eventType: "approved",
          actorId: `synthetic-reviewer-${index}`,
          reasonCode: "SYNTHETIC_APPROVAL",
          fromSnapshotId: draft.id,
          toSnapshotId: approved.id,
          beforeHash: draft.snapshotHash,
          afterHash: approved.snapshotHash,
        },
      });
      const action = await tx.actionAssignment.create({
        data: {
          userId: user.id,
          recommendationSnapshotId: approved.id,
          localDate,
          difficulty: "standard",
          status: "active",
        },
      });
      const domain = await tx.domainOutbox.create({
        data: {
          eventType: "recommendation.published",
          aggregateId: approved.id,
          userId: user.id,
          idempotencyKey: `qualification-domain:${approved.id}`,
          payload: { recommendation_snapshot_id: approved.id },
          consentRequirements: { create: { purpose: "health_processing", grantEpoch: 1 } },
        },
      });
      const channel = await tx.channelOutbox.create({
        data: {
          userId: user.id,
          channel: "in_app",
          template: "recommendation_snapshot",
          payload: { recommendation_snapshot_id: approved.id },
          idempotencyKey: `qualification-channel:${approved.id}`,
          consentRequirements: { create: { purpose: "health_processing", grantEpoch: 1 } },
        },
      });
      const audit = await tx.auditLog.create({
        data: {
          action: "recommendation.review_published",
          resourceType: "recommendation_snapshot",
          resourceId: approved.id,
          afterHash: approved.snapshotHash,
        },
      });
      await tx.recommendationPublication.create({
        data: {
          snapshotId: approved.id,
          actionAssignmentId: action.id,
          domainOutboxId: domain.id,
          auditLogId: audit.id,
          channels: { create: { channelOutboxId: channel.id } },
        },
      });
    }
  }, { timeout: 30_000 });
}

const baseRuleInput = {
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

async function pendingRun(
  ruleInput: Record<string, unknown>,
  autoPublishEligible = false,
  qualifyRule = autoPublishEligible,
  userId?: string,
  enableFeature = true,
) {
  const bundle = await activeBundle(autoPublishEligible, qualifyRule);
  const user = await database.user.create({ data: { ...(userId ? { id: userId } : {}), consentEpoch: 1 } });
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
  const event = await database.profileEvent.create({
    data: {
      userId: user.id,
      consentEpoch: 1,
      eventType: "limitation_confirmed",
      source: "synthetic",
      payload: { code: "none", active: false },
      payloadHash: "a".repeat(64),
      correlationId: randomUUID(),
    },
  });
  const profile = await database.profileSnapshot.create({
    data: {
      userId: user.id,
      version: 1,
      factsJson: {
        daily_health: {},
        labs: {},
        limitations: {},
        rule_input: ruleInput as Prisma.InputJsonObject,
      },
      sourceEventUntil: event.id,
      sourceSequence: event.sequence,
      consentEpoch: 1,
      snapshotHash: "b".repeat(64),
    },
  });
  const run = await database.recommendationRun.create({
    data: {
      userId: user.id,
      localDate: new Date("2026-07-11T00:00:00.000Z"),
      inputSnapshotId: profile.id,
      ruleBundleId: bundle.id,
      consentEpoch: 1,
      inputHash: "c".repeat(64),
      inputManifestJson: {
        profile_snapshot_id: profile.id,
        profile_snapshot_hash: profile.snapshotHash,
        consent_epoch: 1,
        rule_input: ruleInput,
        fact_inputs: [],
        lab_inputs: [],
        rule_bundle_id: bundle.id,
        rule_bundle_digest: bundle.bundleDigest,
      } as Prisma.InputJsonObject,
      correlationId: randomUUID(),
    },
  });
  const outbox = await database.domainOutbox.create({
    data: {
      eventType: "recommendation.run.requested",
      aggregateId: run.id,
      userId: user.id,
      idempotencyKey: `recommendation.run.requested:${run.id}`,
      payload: { recommendation_run_id: run.id },
      consentRequirements: { create: { purpose: "health_processing", grantEpoch: 1 } },
    },
  });
  if (enableFeature) {
    await setSafetyControl({
      controlType: "feature_flag",
      key: "feature.daily_recommendations",
      scopeType: "global",
      scopeId: "*",
    });
  }
  return { run, user, outbox };
}

async function setSafetyControl(input: {
  controlType?: "feature_flag" | "kill_switch";
  key: "feature.daily_recommendations" | "global.proactive_messages" | "user.recommendations" | "rule.bundle" | "llm.generation";
  scopeType: "global" | "user" | "rule_bundle";
  scopeId: string;
  active?: boolean;
  version?: number;
}) {
  const controlType = input.controlType ?? "kill_switch";
  const active = input.active ?? true;
  const version = input.version ?? 1;
  const actor = await database.adminActor.create({ data: {
    lookupHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
    displayLabel: "Synthetic recommendation operator",
    roles: { create: [{ role: "operator" }] },
  } });
  const reason = "synthetic_test";
  const correlationId = randomUUID();
  const revisionId = randomUUID();
  await database.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "safety_control_epoch" WHERE "id" = 'global' FOR UPDATE`;
    const previous = await tx.safetyControlRevision.findFirst({
      where: {
        controlType,
        controlKey: input.key,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
      },
      orderBy: { version: "desc" },
    });
    const [snapshots] = await tx.$queryRaw<Array<{
      before_json: Prisma.JsonValue | null;
      after_json: Prisma.JsonValue;
      before_hash: string;
      after_hash: string;
    }>>`
      SELECT
        ${previous ? Prisma.sql`healthos_safety_control_snapshot(
          ${previous.controlType}, ${previous.controlKey}, ${previous.scopeType}, ${previous.scopeId},
          ${previous.active}, ${previous.version}::integer, ${previous.reason}
        )` : Prisma.sql`NULL::jsonb`} AS "before_json",
        healthos_safety_control_snapshot(${controlType}, ${input.key}, ${input.scopeType}, ${input.scopeId},
          ${active}, ${version}::integer, ${reason}) AS "after_json",
        encode(digest(coalesce(${previous ? Prisma.sql`healthos_safety_control_snapshot(
          ${previous.controlType}, ${previous.controlKey}, ${previous.scopeType}, ${previous.scopeId},
          ${previous.active}, ${previous.version}::integer, ${previous.reason}
        )` : Prisma.sql`NULL::jsonb`}, 'null'::jsonb)::text, 'sha256'), 'hex') AS "before_hash",
        encode(digest(healthos_safety_control_snapshot(${controlType}, ${input.key}, ${input.scopeType}, ${input.scopeId},
          ${active}, ${version}::integer, ${reason})::text, 'sha256'), 'hex') AS "after_hash"
    `;
    assert.ok(snapshots);
    const audit = await tx.auditLog.create({ data: {
      adminActorId: actor.id,
      actorRole: "operator",
      action: active ? "safety_control.activate" : "safety_control.deactivate",
      resourceType: "safety_control",
      resourceId: revisionId,
      reason,
      correlationId,
      beforeJson: snapshots.before_json === null ? Prisma.DbNull : snapshots.before_json as Prisma.InputJsonValue,
      afterJson: snapshots.after_json as Prisma.InputJsonValue,
      beforeHash: snapshots.before_hash,
      afterHash: snapshots.after_hash,
      operationVersion: version,
    } });
    await tx.$executeRaw`SELECT set_config('healthos.safety_control_audit_id', ${audit.id}, true)`;
    await tx.safetyControlRevision.create({ data: {
      id: revisionId,
      controlType,
      controlKey: input.key,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      subjectUserId: input.scopeType === "user" ? input.scopeId : null,
      ruleBundleId: input.scopeType === "rule_bundle" ? input.scopeId : null,
      active,
      version,
      reason,
      adminActorId: actor.id,
      correlationId,
    } });
    await tx.safetyControlAuditConsumption.create({ data: {
      auditId: audit.id,
      controlRevisionId: revisionId,
      operationVersion: version,
    } });
    await tx.safetyControlEpoch.update({ where: { id: "global" }, data: { version: { increment: 1 } } });
  });
}

test("Alpha always creates one immutable review draft and exact retries do not duplicate", async () => {
  const { run } = await pendingRun(baseRuleInput);
  const worker = new RecommendationWorker(database, alphaPolicy);
  const lease = await worker.claim(run.id);
  const snapshot = await worker.process(run.id, lease.leaseToken!);
  assert.equal(snapshot?.reviewStatus, "review_required");
  assert.equal(await database.recommendationReviewTask.count(), 1);
  assert.equal(await database.recommendationPublication.count(), 0);
  assert.equal(await database.recommendationSnapshot.count(), 1);
  const retry = await worker.process(run.id, lease.leaseToken!);
  assert.equal(retry?.id, snapshot?.id);
  assert.equal(await database.recommendationSnapshot.count(), 1);
  await assert.rejects(worker.claim(run.id));
});

test("Beta allowlisted normal output publishes one atomic action and outbox manifest", async () => {
  const { run, user } = await pendingRun(
    baseRuleInput,
    true,
    true,
    "00000000-0000-4000-8000-000000000002",
  );
  const worker = new RecommendationWorker(database, { ...alphaPolicy, releaseStage: "beta", normalSamplePercent: 20 });
  const lease = await worker.claim(run.id);
  const snapshot = await worker.process(run.id, lease.leaseToken!);
  assert.equal(snapshot?.reviewStatus, "published");
  assert.equal(snapshot?.reviewRoute, "auto_publish");
  assert.equal(await database.recommendationPublication.count({ where: { snapshotId: snapshot!.id } }), 1);
  assert.equal(await database.actionAssignment.count({ where: { userId: user.id, status: "active" } }), 1);
  assert.equal(await database.domainOutbox.count({ where: { userId: user.id, eventType: "recommendation.published" } }), 1);
  assert.equal(await database.channelOutbox.count({ where: { userId: user.id, channel: "in_app" } }), 1);
  assert.equal(await database.auditLog.count({ where: { action: "recommendation.auto_published" } }), 1);
  const provenance = snapshot?.provenanceJson as Prisma.JsonObject;
  assert.equal(provenance.provider_id, null);
  assert.equal(provenance.model_id, null);
  assert.equal(provenance.llm_kill_switch_active, true);
  const domain = await database.domainOutbox.findFirstOrThrow({ where: { userId: user.id, eventType: "recommendation.published" } });
  await assert.rejects(database.domainOutbox.update({
    where: { id: domain.id },
    data: { payload: { recommendation_snapshot_id: randomUUID() } },
  }), /immutable/i);
  await assert.rejects(database.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL healthos.allow_privacy_delete = 'on'");
    await tx.domainOutbox.delete({ where: { id: domain.id } });
  }), /immutable/i);
  const channel = await database.channelOutbox.findFirstOrThrow({ where: { userId: user.id, channel: "in_app" } });
  await assert.rejects(database.channelOutbox.update({
    where: { id: channel.id },
    data: { template: "tampered" },
  }), /immutable/i);
  const action = await database.actionAssignment.findFirstOrThrow({ where: { userId: user.id } });
  await assert.rejects(database.actionAssignment.update({
    where: { id: action.id },
    data: { difficulty: "tampered" },
  }), /immutable/i);
  await database.user.update({ where: { id: user.id }, data: { status: "deleting", deletedAt: new Date() } });
  await database.$queryRaw`SELECT "healthos_delete_frozen_user"(${user.id}::uuid)`;
  assert.equal(await database.user.count({ where: { id: user.id } }), 0);
});

test("immutable run manifest and request outbox cannot be changed after creation", async () => {
  const { run, outbox } = await pendingRun(baseRuleInput);
  await assert.rejects(database.recommendationRun.update({
    where: { id: run.id },
    data: { inputManifestJson: { rule_input: { ...baseRuleInput, acute_symptoms: true } } },
  }), /immutable/i);
  await assert.rejects(database.domainOutbox.update({
    where: { id: outbox.id },
    data: { payload: { recommendation_run_id: run.id, rule_input: { ...baseRuleInput, acute_symptoms: true } } },
  }), /immutable/i);
});

test("a newer same-epoch profile suppresses a run before evaluation", async () => {
  const { run, user } = await pendingRun(baseRuleInput);
  const event = await database.profileEvent.create({
    data: {
      userId: user.id,
      consentEpoch: 1,
      eventType: "limitation_confirmed",
      source: "synthetic",
      payload: { code: "knee_discomfort", active: true },
      payloadHash: "7".repeat(64),
      correlationId: randomUUID(),
    },
  });
  await database.profileSnapshot.create({
    data: {
      userId: user.id,
      version: 2,
      consentEpoch: 1,
      factsJson: { limitations: { knee_discomfort: { active: true } }, rule_input: baseRuleInput },
      sourceEventUntil: event.id,
      sourceSequence: event.sequence,
      snapshotHash: "6".repeat(64),
    },
  });
  const worker = new RecommendationWorker(database, alphaPolicy);
  const lease = await worker.claim(run.id);
  assert.equal(await worker.process(run.id, lease.leaseToken!), null);
  assert.equal((await database.recommendationRun.findUniqueOrThrow({ where: { id: run.id } })).status, "suppressed");
});

test("daily recommendation feature flag is fail-closed when no enabling revision exists", async () => {
  const featureCase = await pendingRun(baseRuleInput, false, false, undefined, false);
  const worker = new RecommendationWorker(database, alphaPolicy);
  const lease = await worker.claim(featureCase.run.id);
  assert.equal(await worker.process(featureCase.run.id, lease.leaseToken!), null);
  assert.equal((await database.recommendationRun.findUniqueOrThrow({
    where: { id: featureCase.run.id },
  })).status, "suppressed");
});

test("missing safety-control epoch suppresses recommendation execution", async () => {
  const epochCase = await pendingRun(baseRuleInput);
  const worker = new RecommendationWorker(database, alphaPolicy);
  const lease = await worker.claim(epochCase.run.id);
  await withMissingControlEpoch(async () => {
    assert.equal(await worker.process(epochCase.run.id, lease.leaseToken!), null);
  });
  assert.equal((await database.recommendationRun.findUniqueOrThrow({
    where: { id: epochCase.run.id },
  })).status, "suppressed");
});

test("a concurrently activated global switch suppresses at the execution boundary", async () => {
  const globalCase = await pendingRun(baseRuleInput);
  const globalWorker = new RecommendationWorker(database, alphaPolicy);
  const globalLease = await globalWorker.claim(globalCase.run.id);
  let releaseEpoch!: () => void;
  let epochLocked!: () => void;
  const release = new Promise<void>((resolve) => { releaseEpoch = resolve; });
  const locked = new Promise<void>((resolve) => { epochLocked = resolve; });
  const blockingTransaction = database.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "safety_control_epoch" WHERE "id" = 'global' FOR UPDATE`;
    epochLocked();
    await release;
  });
  await locked;
  const activation = setSafetyControl({ key: "global.proactive_messages", scopeType: "global", scopeId: "*" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  let processingSettled = false;
  const processing = globalWorker.process(globalCase.run.id, globalLease.leaseToken!).then((result) => {
    processingSettled = true;
    return result;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(processingSettled, false);
    releaseEpoch();
    await blockingTransaction;
    await activation;
    assert.equal(await processing, null);
  } finally {
    releaseEpoch();
    await blockingTransaction;
  }
  assert.equal((await database.recommendationRun.findUniqueOrThrow({ where: { id: globalCase.run.id } })).status, "suppressed");
});

test("user recommendation kill switch is isolated to its exact user", async () => {
  const userCase = await pendingRun(baseRuleInput);
  await setSafetyControl({
    key: "user.recommendations",
    scopeType: "user",
    scopeId: userCase.user.id,
  });
  const worker = new RecommendationWorker(database, alphaPolicy);
  const lease = await worker.claim(userCase.run.id);
  assert.equal(await worker.process(userCase.run.id, lease.leaseToken!), null);
  assert.equal((await database.recommendationRun.findUniqueOrThrow({ where: { id: userCase.run.id } })).status, "suppressed");
});

test("rule-bundle kill switch suppresses the exact running bundle", async () => {
  const ruleCase = await pendingRun(baseRuleInput);
  await setSafetyControl({
    key: "rule.bundle",
    scopeType: "rule_bundle",
    scopeId: ruleCase.run.ruleBundleId,
  });
  const worker = new RecommendationWorker(database, alphaPolicy);
  const lease = await worker.claim(ruleCase.run.id);
  assert.equal(await worker.process(ruleCase.run.id, lease.leaseToken!), null);
  assert.equal((await database.recommendationRun.findUniqueOrThrow({ where: { id: ruleCase.run.id } })).status, "suppressed");
});

test("LLM kill switch keeps the deterministic template path and records fallback provenance", async () => {
  const llmCase = await pendingRun(baseRuleInput);
  await setSafetyControl({ key: "llm.generation", scopeType: "global", scopeId: "*" });
  const worker = new RecommendationWorker(database, { ...alphaPolicy, llmEnabled: true });
  const lease = await worker.claim(llmCase.run.id);
  const snapshot = await worker.process(llmCase.run.id, lease.leaseToken!);
  assert.ok(snapshot);
  const provenance = snapshot.provenanceJson as Prisma.JsonObject;
  assert.equal(provenance.llm_kill_switch_active, true);
  assert.equal(provenance.provider_id, null);
  assert.equal(provenance.model_id, null);
});

test("Beta holds a normal action when the exact rule lacks qualification evidence", async () => {
  const { run } = await pendingRun(baseRuleInput, true, false);
  const worker = new RecommendationWorker(database, { ...alphaPolicy, releaseStage: "beta", normalSamplePercent: 20 });
  const lease = await worker.claim(run.id);
  const snapshot = await worker.process(run.id, lease.leaseToken!);
  assert.equal(snapshot?.reviewStatus, "review_required");
  assert.equal(await database.recommendationPublication.count({ where: { snapshot: { runId: run.id } } }), 0);
});

test("one reviewed snapshot cannot be replayed into 100 qualification approvals", async () => {
  await activeBundle(true, true);
  const approved = await database.recommendationReviewEvent.findFirstOrThrow({
    where: { eventType: "approved" },
  });
  await assert.rejects(database.recommendationReviewEvent.create({
    data: {
      snapshotId: approved.snapshotId,
      eventType: "approved",
      actorId: "synthetic-duplicate-reviewer",
      reasonCode: "DUPLICATE_APPROVAL",
      fromSnapshotId: approved.fromSnapshotId,
      toSnapshotId: approved.toSnapshotId,
      beforeHash: approved.beforeHash,
      afterHash: approved.afterHash,
    },
  }));
  assert.equal(await database.recommendationReviewEvent.count({ where: { eventType: "approved" } }), 100);
});

test("database recomputes beta sampling and rejects a forged auto-publish bucket", async () => {
  const { run } = await pendingRun(
    baseRuleInput,
    true,
    true,
    "00000000-0000-4000-8000-000000000001",
  );
  const worker = new RecommendationWorker(database, { ...alphaPolicy, releaseStage: "beta", normalSamplePercent: 20 });
  const lease = await worker.claim(run.id);
  const draft = await worker.process(run.id, lease.leaseToken!);
  assert.equal(draft?.reviewStatus, "review_required");
  assert.equal(draft?.samplingBucket, 17);

  await assert.rejects(database.$transaction(async (tx) => {
    const forged = await tx.recommendationSnapshot.create({
      data: {
        runId: run.id,
        revision: 2,
        supersedesId: draft!.id,
        riskArea: draft!.riskArea,
        safetyClass: draft!.safetyClass,
        actionCode: draft!.actionCode,
        renderedPayloadJson: draft!.renderedPayloadJson as Prisma.InputJsonValue,
        canonicalRuleInputJson: draft!.canonicalRuleInputJson as Prisma.InputJsonValue,
        provenanceJson: draft!.provenanceJson as Prisma.InputJsonValue,
        reviewStatus: "published",
        releaseStage: "beta",
        reviewRoute: "auto_publish",
        policyDigest: draft!.policyDigest,
        samplingBucket: 99,
        reviewSamplePercent: 20,
      },
    });
    await tx.recommendationReviewEvent.create({
      data: { snapshotId: forged.id, eventType: "auto_published" },
    });
    const action = await tx.actionAssignment.create({
      data: {
        userId: run.userId,
        recommendationSnapshotId: forged.id,
        localDate: run.localDate,
        difficulty: "standard",
        status: "active",
      },
    });
    const domain = await tx.domainOutbox.create({
      data: {
        eventType: "recommendation.published",
        aggregateId: forged.id,
        userId: run.userId,
        idempotencyKey: `forged-domain:${forged.id}`,
        payload: { recommendation_snapshot_id: forged.id },
        consentRequirements: { create: { purpose: "health_processing", grantEpoch: run.consentEpoch } },
      },
    });
    const channel = await tx.channelOutbox.create({
      data: {
        userId: run.userId,
        channel: "in_app",
        template: "recommendation_snapshot",
        payload: { recommendation_snapshot_id: forged.id },
        idempotencyKey: `forged-channel:${forged.id}`,
        consentRequirements: { create: { purpose: "health_processing", grantEpoch: run.consentEpoch } },
      },
    });
    const audit = await tx.auditLog.create({
      data: {
        action: "recommendation.auto_published",
        resourceType: "recommendation_snapshot",
        resourceId: forged.id,
        afterHash: forged.snapshotHash,
      },
    });
    await tx.recommendationPublication.create({
      data: {
        snapshotId: forged.id,
        actionAssignmentId: action.id,
        domainOutboxId: domain.id,
        auditLogId: audit.id,
        channels: { create: { channelOutboxId: channel.id } },
      },
    });
  }), /Beta auto-publish policy/i);
  assert.equal(await database.recommendationPublication.count({ where: { snapshot: { runId: run.id } } }), 0);
});

test("a later safety incident immediately revokes rule-level auto-publication", async () => {
  const { run } = await pendingRun(
    baseRuleInput,
    true,
    true,
    "00000000-0000-4000-8000-000000000003",
  );
  await database.safetyIncident.create({
    data: {
      userId: run.userId,
      source: "rule:sleep_recovery:SLEEP_WIND_DOWN",
      severity: "high",
      detailsEncrypted: "synthetic-ciphertext",
    },
  });
  const worker = new RecommendationWorker(database, { ...alphaPolicy, releaseStage: "beta", normalSamplePercent: 20 });
  const lease = await worker.claim(run.id);
  const snapshot = await worker.process(run.id, lease.leaseToken!);
  assert.equal(snapshot?.reviewStatus, "review_required");
  assert.equal(await database.recommendationPublication.count({ where: { snapshot: { runId: run.id } } }), 0);
  const incident = await database.safetyIncident.findFirstOrThrow();
  await assert.rejects(database.safetyIncident.update({
    where: { id: incident.id },
    data: { source: "rule:other" },
  }), /append-only/i);
  await assert.rejects(database.safetyIncident.delete({ where: { id: incident.id } }), /append-only/i);
  await database.user.update({
    where: { id: run.userId },
    data: { status: "deleting", deletedAt: new Date() },
  });
  await database.$queryRaw`SELECT "healthos_delete_frozen_user"(${run.userId}::uuid)`;
  assert.equal((await database.safetyIncident.findUniqueOrThrow({ where: { id: incident.id } })).userId, null);
});

test("worker and incident writer use the same user-then-rule lock order", async () => {
  const { run } = await pendingRun(baseRuleInput);
  let markUserLocked!: () => void;
  let releaseWorker!: () => void;
  const userLocked = new Promise<void>((resolve) => { markUserLocked = resolve; });
  const workerMayContinue = new Promise<void>((resolve) => { releaseWorker = resolve; });
  const ruleSource = "rule:sleep_recovery:SLEEP_WIND_DOWN";

  const workerTransaction = database.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${run.userId}::uuid FOR UPDATE`;
    markUserLocked();
    await workerMayContinue;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ruleSource}, 0))`;
  });
  await userLocked;
  const incidentInsert = database.safetyIncident.create({
    data: {
      userId: run.userId,
      source: ruleSource,
      severity: "high",
      detailsEncrypted: "synthetic-concurrent-ciphertext",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  releaseWorker();
  await Promise.all([workerTransaction, incidentInsert]);
  assert.equal(await database.safetyIncident.count({ where: { source: ruleSource } }), 1);
});

test("doctor uses a fixed fallback and review task while blocked never publishes", async () => {
  const doctorRun = await pendingRun({ ...baseRuleInput, age_group: "minor" });
  const doctorWorker = new RecommendationWorker(database, alphaPolicy);
  const doctorLease = await doctorWorker.claim(doctorRun.run.id);
  const doctor = await doctorWorker.process(doctorRun.run.id, doctorLease.leaseToken!);
  assert.equal(doctor?.reviewRoute, "fixed_fallback");
  assert.equal(doctor?.actionCode, null);
  assert.equal(await database.recommendationPublication.count(), 1);
  assert.equal(await database.actionAssignment.count(), 0);
  assert.equal(await database.recommendationReviewTask.count(), 1);

  await database.$executeRawUnsafe(`
    TRUNCATE TABLE users, rule_bundles, audit_logs, privacy_reconciliation
    RESTART IDENTITY CASCADE
  `);
  await database.privacyReconciliation.create({ data: { id: "global", status: "ready" } });
  const blockedRun = await pendingRun({ ...baseRuleInput, acute_symptoms: true });
  const blockedLease = await doctorWorker.claim(blockedRun.run.id);
  const blocked = await doctorWorker.process(blockedRun.run.id, blockedLease.leaseToken!);
  assert.equal(blocked?.reviewStatus, "blocked");
  assert.equal(await database.recommendationPublication.count(), 0);
  assert.equal(await database.channelOutbox.count(), 0);
});

test("withdrawn consent suppresses claimed work and an expired lease cannot commit", async () => {
  const consentCase = await pendingRun(baseRuleInput);
  const worker = new RecommendationWorker(database, alphaPolicy);
  const lease = await worker.claim(consentCase.run.id);
  await database.consentRecord.create({
    data: {
      userId: consentCase.user.id,
      consentType: "health_processing",
      documentVersion: "synthetic-v1",
      granted: false,
      epoch: 2,
      correlationId: randomUUID(),
      requestHash: randomUUID(),
      source: "synthetic",
    },
  });
  await database.user.update({ where: { id: consentCase.user.id }, data: { consentEpoch: 2 } });
  assert.equal(await worker.process(consentCase.run.id, lease.leaseToken!), null);
  assert.equal((await database.recommendationRun.findUniqueOrThrow({ where: { id: consentCase.run.id } })).status, "suppressed");

  await database.$executeRawUnsafe(`
    TRUNCATE TABLE users, rule_bundles, audit_logs, privacy_reconciliation
    RESTART IDENTITY CASCADE
  `);
  await database.privacyReconciliation.create({ data: { id: "global", status: "ready" } });
  const staleCase = await pendingRun(baseRuleInput);
  const staleLease = await worker.claim(staleCase.run.id);
  await database.recommendationRun.update({
    where: { id: staleCase.run.id },
    data: { leaseUntil: new Date(Date.now() - 1_000) },
  });
  await assert.rejects(worker.process(staleCase.run.id, staleLease.leaseToken!), /stale/i);
  assert.equal(await database.recommendationSnapshot.count(), 0);
});
