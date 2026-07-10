import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, test } from "node:test";

import { PrismaClient, type Prisma } from "@prisma/client";

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
  return { run, user, outbox };
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
