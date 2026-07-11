import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";

import { createApp } from "../src/main";
import { DatabaseService } from "../src/database/prisma.service";
import { RULES_ENGINE_ARTIFACT_DIGEST } from "../src/recommendations/rule-bundle.service";

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

describe("database invariants", () => {
  const database = new DatabaseService();

  beforeAll(async () => {
    await database.$connect();
  });

  afterEach(async () => {
    await database.$executeRawUnsafe(`
      TRUNCATE TABLE
        domain_outbox,
        action_assignments,
        recommendation_snapshots,
        recommendation_runs,
        rule_bundles,
        profile_snapshots,
        profile_events,
        lab_observations,
        lab_documents,
        channel_accounts,
        users
      RESTART IDENTITY CASCADE
    `);
  });

  afterAll(async () => {
    await database.$disconnect();
  });

  async function createRecommendationRun() {
    const user = await database.user.create({
      data: { locale: "zh-CN", timezone: "Asia/Shanghai", consentEpoch: 1 },
    });
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
    await database.privacyReconciliation.update({ where: { id: "global" }, data: { status: "ready" } });
    const profileEvent = await database.profileEvent.create({
      data: {
        userId: user.id,
        eventType: "synthetic_profile_created",
        source: "test",
        payload: {},
        consentEpoch: 1,
        payloadHash: "a".repeat(64),
        correlationId: randomUUID(),
      },
    });
    const profile = await database.profileSnapshot.create({
      data: {
        userId: user.id,
        version: 1,
        factsJson: { rule_input: ruleInput },
        sourceEventUntil: profileEvent.id,
        sourceSequence: profileEvent.sequence,
        consentEpoch: 1,
        snapshotHash: "b".repeat(64),
      },
    });
    const draftBundle = await database.ruleBundle.create({
      data: {
        version: "test-v1",
        contentJson: {
          rules_engine: "deterministic-rules-v1",
          rules_engine_digest: RULES_ENGINE_ARTIFACT_DIGEST,
          safety_bundle_digest: "1".repeat(64),
          localization_bundle_digest: "2".repeat(64),
          template_bundle_digest: "3".repeat(64),
          beta_normal_review_percent: 20,
          rules: ["synthetic"],
        },
        contentHash: "0".repeat(64),
        bundleDigest: "0".repeat(64),
      },
    });
    await database.ruleBundleApproval.createMany({ data: [
      { ruleBundleId: draftBundle.id, role: "technical", actorId: "synthetic-tech", normalizedActor: "synthetic-tech", bundleDigest: draftBundle.bundleDigest!, approvedAt: new Date() },
      { ruleBundleId: draftBundle.id, role: "medical", actorId: "synthetic-medical", normalizedActor: "synthetic-medical", bundleDigest: draftBundle.bundleDigest!, approvedAt: new Date() },
    ] });
    const bundle = await database.ruleBundle.update({
      where: { id: draftBundle.id },
      data: { status: "active", publishedBy: "synthetic-publisher", publishedAt: new Date() },
    });
    const run = await database.recommendationRun.create({
      data: {
        userId: user.id,
        localDate: new Date("2026-07-10T00:00:00.000Z"),
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
        },
        status: "completed",
        correlationId: randomUUID(),
      },
    });
    return { bundle, profile, run, user };
  }

  async function createPublishedSnapshot() {
    const { run, user } = await createRecommendationRun();
    const snapshot = await database.recommendationSnapshot.create({
      data: {
        runId: run.id,
        revision: 1,
        riskArea: "sleep",
        safetyClass: "normal",
        actionCode: "sleep_consistency",
        renderedPayloadJson: { title: "Synthetic action" },
        canonicalRuleInputJson: { lab_observation_ids: [] },
        provenanceJson: { synthetic: true },
        reviewStatus: "review_required",
        releaseStage: "alpha",
        reviewRoute: "review_required",
        policyDigest: "d".repeat(64),
      },
    });
    return { run, snapshot, user };
  }

  test("allows only one active primary action per user and local date", async () => {
    const { snapshot, user } = await createPublishedSnapshot();
    const localDate = new Date("2026-07-10T00:00:00.000Z");
    await database.actionAssignment.create({
      data: {
        userId: user.id,
        recommendationSnapshotId: snapshot.id,
        localDate,
        difficulty: "standard",
        status: "active",
        isPrimary: true,
      },
    });

    await expect(
      database.actionAssignment.create({
        data: {
          userId: user.id,
          recommendationSnapshotId: snapshot.id,
          localDate,
          difficulty: "lighter",
          status: "active",
          isPrimary: true,
        },
      }),
    ).rejects.toThrow();
  });

  test("enforces global outbox idempotency", async () => {
    const idempotencyKey = "recommendation:synthetic:1";
    await database.domainOutbox.create({
      data: {
        eventType: "recommendation.published",
        aggregateId: randomUUID(),
        payload: {},
        idempotencyKey,
      },
    });

    await expect(
      database.domainOutbox.create({
        data: {
          eventType: "recommendation.published",
          aggregateId: randomUUID(),
          payload: {},
          idempotencyKey,
        },
      }),
    ).rejects.toThrow();
  });

  test("keeps recommendation snapshots immutable", async () => {
    const { snapshot } = await createPublishedSnapshot();

    await expect(
      database.recommendationSnapshot.update({
        where: { id: snapshot.id },
        data: { actionCode: "mutated_action" },
      }),
    ).rejects.toThrow(/append-only|immutable/i);
  });

  test("records corrections as a higher revision in the same run", async () => {
    const { run, snapshot } = await createPublishedSnapshot();

    const correction = await database.recommendationSnapshot.create({
      data: {
        runId: run.id,
        revision: 2,
        riskArea: "sleep",
        safetyClass: "normal",
        actionCode: "sleep_consistency_lighter",
        renderedPayloadJson: {},
        canonicalRuleInputJson: { lab_observation_ids: [] },
        provenanceJson: { synthetic: true },
        reviewStatus: "review_required",
        releaseStage: "alpha",
        reviewRoute: "review_required",
        policyDigest: "d".repeat(64),
        supersedesId: snapshot.id,
      },
    });

    expect(correction.revision).toBe(2);
    expect(correction.supersedesId).toBe(snapshot.id);
  });

  test("allows append-only deletion only inside the privacy-delete transaction", async () => {
    const { user } = await createPublishedSnapshot();

    await database.healthSyncRun.create({
      data: {
        userId: user.id,
        deviceId: "synthetic-delete-device",
        anchorEpoch: 1,
        idempotencyKey: randomUUID(),
        requestHash: randomUUID(),
        timezone: "Asia/Shanghai",
        consentEpoch: 1,
        status: "completed",
        completedAt: new Date(),
        correlationId: randomUUID(),
      },
    });

    await expect(database.user.delete({ where: { id: user.id } })).rejects.toThrow(
      /append-only/i,
    );

    await expect(database.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL healthos.allow_privacy_delete = 'on'");
      await transaction.user.delete({ where: { id: user.id } });
    })).rejects.toThrow(/append-only/i);

    await database.user.update({
      where: { id: user.id },
      data: { status: "deleting", deletedAt: new Date() },
    });
    await database.$queryRaw`SELECT "healthos_delete_frozen_user"(${user.id}::uuid)`;

    expect(await database.user.count({ where: { id: user.id } })).toBe(0);
    expect(await database.healthSyncRun.count({ where: { userId: user.id } })).toBe(0);
  });

  test("rejects publication when canonical inputs reference unconfirmed labs", async () => {
    const { run, user } = await createRecommendationRun();
    const document = await database.labDocument.create({
      data: {
        userId: user.id,
        objectKey: "synthetic/lab.pdf",
        sha256: "sha256:synthetic-lab",
        status: "completed",
      },
    });
    const observation = await database.labObservation.create({
      data: {
        documentId: document.id,
        code: "LDL_C",
        value: "3.1",
        unit: "mmol/L",
        evidenceBox: {},
        confidence: 0.99,
        confirmationStatus: "needs_confirmation",
      },
    });

    await expect(
      database.recommendationSnapshot.create({
        data: {
          runId: run.id,
          revision: 1,
          riskArea: "metabolic",
          safetyClass: "caution",
          actionCode: "meal_balance",
          renderedPayloadJson: {},
          canonicalRuleInputJson: { lab_observation_ids: [observation.id] },
          provenanceJson: {},
          reviewStatus: "published",
        },
      }),
    ).rejects.toThrow(/unconfirmed lab/i);
  });

  test("rejects a direct published snapshot without its atomic publication manifest", async () => {
    const { bundle, profile, run } = await createRecommendationRun();
    await expect(database.$transaction(async (tx) => {
      await tx.recommendationSnapshot.create({
        data: {
          runId: run.id,
          revision: 1,
          riskArea: "sleep_recovery",
          safetyClass: "normal",
          actionCode: "SLEEP_WIND_DOWN",
          renderedPayloadJson: {
            template: "daily_action_v1",
            action_code: "SLEEP_WIND_DOWN",
            safety_class: "normal",
            risk_area: "sleep_recovery",
          },
          canonicalRuleInputJson: { lab_observation_ids: [] },
          provenanceJson: {
            profile_snapshot_id: profile.id,
            profile_snapshot_hash: profile.snapshotHash,
            daily_fact_revision_ids: [],
            daily_fact_input_hashes: [],
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
            rendered_payload_hash: "e".repeat(64),
            generated_at: "2026-07-11T00:00:00.000Z",
            rule_result: {
              outcome: "action",
              safetyClass: "normal",
              actionCode: "SLEEP_WIND_DOWN",
              riskArea: "sleep_recovery",
            },
            rule_key: "sleep_recovery:SLEEP_WIND_DOWN",
          },
          reviewStatus: "published",
          releaseStage: "beta",
          reviewRoute: "auto_publish",
          policyDigest: "f".repeat(64),
          samplingBucket: 99,
          reviewSamplePercent: 20,
        },
      });
    })).rejects.toThrow(/manifest/i);
    expect(await database.recommendationSnapshot.count({ where: { runId: run.id } })).toBe(0);
  });

  test("rejects a recommendation run bound to another user's profile snapshot", async () => {
    const { bundle, user } = await createRecommendationRun();
    const other = await database.user.create({ data: { consentEpoch: 0 } });
    const event = await database.profileEvent.create({
      data: { userId: other.id, eventType: "synthetic_profile_created", source: "synthetic", payload: {}, correlationId: randomUUID() },
    });
    const profile = await database.profileSnapshot.create({
      data: { userId: other.id, version: 1, factsJson: { rule_input: ruleInput }, sourceEventUntil: event.id, sourceSequence: event.sequence },
    });
    await expect(database.recommendationRun.create({
      data: {
        userId: user.id,
        localDate: new Date("2026-07-12T00:00:00.000Z"),
        inputSnapshotId: profile.id,
        ruleBundleId: bundle.id,
        consentEpoch: 0,
        inputHash: "f".repeat(64),
        inputManifestJson: { rule_input: ruleInput },
        correlationId: randomUUID(),
      },
    })).rejects.toThrow();
  });

  test("rejects a revision gap and a stale active run without complete lease fields", async () => {
    const { run } = await createRecommendationRun();
    await expect(database.recommendationSnapshot.create({
      data: {
        runId: run.id,
        revision: 2,
        riskArea: "sleep_recovery",
        safetyClass: "normal",
        actionCode: "SLEEP_WIND_DOWN",
        renderedPayloadJson: {},
        canonicalRuleInputJson: {},
        provenanceJson: {},
        reviewStatus: "review_required",
        releaseStage: "alpha",
        reviewRoute: "review_required",
        policyDigest: "f".repeat(64),
      },
    })).rejects.toThrow(/predecessor/i);
    await expect(database.recommendationRun.update({
      where: { id: run.id },
      data: { status: "active" },
    })).rejects.toThrow();
  });

  test("keeps channel lookup hashes unique within a tenant", async () => {
    const userA = await database.user.create({ data: {} });
    const userB = await database.user.create({ data: {} });
    const lookup = "hmac:synthetic-user";
    await database.channelAccount.create({
      data: {
        userId: userA.id,
        channel: "wecom",
        tenantId: "synthetic-tenant",
        externalIdLookupHmac: lookup,
        externalIdEncrypted: "ciphertext-a",
        status: "linked",
      },
    });

    await expect(
      database.channelAccount.create({
        data: {
          userId: userB.id,
          channel: "wecom",
          tenantId: "synthetic-tenant",
          externalIdLookupHmac: lookup,
          externalIdEncrypted: "ciphertext-b",
          status: "linked",
        },
      }),
    ).rejects.toThrow();
  });

  test("readiness reports the real database separately", async () => {
    let app: INestApplication | undefined;
    try {
      app = await createApp();
      const response = await app.getHttpAdapter().getInstance().inject({
        method: "GET",
        url: "/health/ready",
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        status: "not_ready",
        dependencies: {
          database: { status: "ok" },
          object_storage: { status: "not_configured" },
          worker_lease: { status: "not_configured" },
        },
      });
    } finally {
      await app?.close();
    }
  });
});
