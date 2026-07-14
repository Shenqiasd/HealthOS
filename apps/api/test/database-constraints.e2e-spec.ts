import { createHash, randomUUID } from "node:crypto";
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
    await database.$executeRawUnsafe(`
      DO $role$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'healthos_restricted_app') THEN
          CREATE ROLE healthos_restricted_app NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'healthos_privacy_worker') THEN
          CREATE ROLE healthos_privacy_worker NOLOGIN;
        END IF;
      END;
      $role$
    `);
  });

  beforeEach(async () => {
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

  function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  async function createCoachFixture() {
    const owner = await database.user.create({ data: { locale: "zh-CN", timezone: "Asia/Shanghai", consentEpoch: 1 } });
    const other = await database.user.create({ data: { locale: "zh-CN", timezone: "Asia/Shanghai", consentEpoch: 1 } });
    await database.consentRecord.createMany({ data: [
      {
        userId: owner.id,
        consentType: "health_processing",
        documentVersion: "synthetic-coach-v1",
        granted: true,
        epoch: 1,
        correlationId: randomUUID(),
        requestHash: randomUUID(),
        source: "synthetic",
      },
      {
        userId: other.id,
        consentType: "health_processing",
        documentVersion: "synthetic-coach-v1",
        granted: true,
        epoch: 1,
        correlationId: randomUUID(),
        requestHash: randomUUID(),
        source: "synthetic",
      },
    ] });
    const ownerThread = await database.coachThread.create({ data: {
      userId: owner.id,
      clientThreadId: randomUUID(),
      idempotencyKey: randomUUID(),
      requestHash: sha256("owner-thread"),
    } });
    const otherThread = await database.coachThread.create({ data: {
      userId: other.id,
      clientThreadId: randomUUID(),
      idempotencyKey: randomUUID(),
      requestHash: sha256("other-thread"),
    } });
    const otherCandidate = await database.profileCandidate.create({ data: {
      userId: other.id,
      candidateType: "mobility_limitation",
      structuredValueJson: { code: "synthetic", active: true },
      sourceTextHash: sha256("synthetic candidate"),
      idempotencyKey: randomUUID(),
      requestHash: sha256("synthetic candidate request"),
    } });
    return { owner, other, ownerThread, otherThread, otherCandidate };
  }

  function coachTurnData(userId: string, threadId: string, candidateId: string | null = null) {
    return {
      userId,
      threadId,
      idempotencyKey: randomUUID(),
      requestHash: sha256(randomUUID()),
      intent: "general_question",
      resultJson: {
        intent: "general_question",
        short_answer: "synthetic",
        reason: "synthetic",
        action_code: null,
        safety_class: "normal",
        source_ids: [],
        needs_human_review: false,
        fixed_response: true,
        fixed_response_code: "coach.evidence_unavailable",
        candidate: null,
      },
      gateEvidenceJson: { summaryVersion: 0, consentEpoch: 1 },
      candidateId,
    };
  }

  function coachMessageData(input: {
    userId: string;
    threadId: string;
    turnId: string;
    sequence: number;
    role: "user" | "assistant";
    content: string;
    contentHash?: string;
  }) {
    return {
      userId: input.userId,
      threadId: input.threadId,
      turnId: input.turnId,
      sequence: input.sequence,
      role: input.role,
      intent: "general_question",
      content: input.content,
      contentHash: input.contentHash ?? sha256(input.content),
      sourcesJson: [],
      evidenceHash: sha256("[]"),
      safetyClass: "normal",
      needsHumanReview: false,
    };
  }

  test("binds every Coach turn and candidate to the same user-owned thread", async () => {
    const fixture = await createCoachFixture();
    await expect(database.coachTurn.create({ data: coachTurnData(
      fixture.owner.id,
      fixture.otherThread.id,
    ) })).rejects.toThrow(/owner|thread|foreign key/i);
    await expect(database.coachTurn.create({ data: coachTurnData(
      fixture.owner.id,
      fixture.ownerThread.id,
      fixture.otherCandidate.id,
    ) })).rejects.toThrow(/candidate|owner|foreign key/i);
  });

  test("binds new turn messages to the same turn thread and user", async () => {
    const fixture = await createCoachFixture();
    await expect(database.$transaction(async (tx) => {
      const turn = await tx.coachTurn.create({ data: coachTurnData(fixture.owner.id, fixture.ownerThread.id) });
      await tx.coachMessage.createMany({ data: [
        coachMessageData({
          userId: fixture.other.id,
          threadId: fixture.ownerThread.id,
          turnId: turn.id,
          sequence: 1,
          role: "user",
          content: "synthetic user",
        }),
        coachMessageData({
          userId: fixture.other.id,
          threadId: fixture.ownerThread.id,
          turnId: turn.id,
          sequence: 2,
          role: "assistant",
          content: "synthetic assistant",
        }),
      ] });
    })).rejects.toThrow(/turn|thread|user|foreign key/i);
  });

  test("verifies Coach content and canonical evidence hashes in the database", async () => {
    const fixture = await createCoachFixture();
    await expect(database.$transaction(async (tx) => {
      const turn = await tx.coachTurn.create({ data: coachTurnData(fixture.owner.id, fixture.ownerThread.id) });
      await tx.coachMessage.createMany({ data: [
        coachMessageData({
          userId: fixture.owner.id,
          threadId: fixture.ownerThread.id,
          turnId: turn.id,
          sequence: 1,
          role: "user",
          content: "synthetic user",
          contentHash: "0".repeat(64),
        }),
        coachMessageData({
          userId: fixture.owner.id,
          threadId: fixture.ownerThread.id,
          turnId: turn.id,
          sequence: 2,
          role: "assistant",
          content: "synthetic assistant",
        }),
      ] });
    })).rejects.toThrow(/content.*hash|hash.*content/i);
  });

  test("verifies the Coach evidence hash against canonical stored JSON", async () => {
    const fixture = await createCoachFixture();
    await expect(database.$transaction(async (tx) => {
      const turn = await tx.coachTurn.create({ data: coachTurnData(fixture.owner.id, fixture.ownerThread.id) });
      await tx.coachMessage.createMany({ data: [
        coachMessageData({
          userId: fixture.owner.id,
          threadId: fixture.ownerThread.id,
          turnId: turn.id,
          sequence: 1,
          role: "user",
          content: "synthetic user",
        }),
        {
          ...coachMessageData({
            userId: fixture.owner.id,
            threadId: fixture.ownerThread.id,
            turnId: turn.id,
            sequence: 2,
            role: "assistant",
            content: "synthetic assistant",
          }),
          evidenceHash: "0".repeat(64),
        },
      ] });
    })).rejects.toThrow(/evidence.*hash|hash.*evidence/i);
  });

  test("requires exactly one user then one assistant message for every new Coach turn", async () => {
    const fixture = await createCoachFixture();
    await expect(database.$transaction(async (tx) => {
      const turn = await tx.coachTurn.create({ data: coachTurnData(fixture.owner.id, fixture.ownerThread.id) });
      await tx.coachMessage.createMany({ data: [
        coachMessageData({
          userId: fixture.owner.id,
          threadId: fixture.ownerThread.id,
          turnId: turn.id,
          sequence: 1,
          role: "assistant",
          content: "synthetic assistant one",
        }),
        coachMessageData({
          userId: fixture.owner.id,
          threadId: fixture.ownerThread.id,
          turnId: turn.id,
          sequence: 3,
          role: "assistant",
          content: "synthetic assistant two",
        }),
      ] });
    })).rejects.toThrow(/exactly|sequence|role|pair/i);
  });

  test("binds persisted Coach gate summary version to the immutable thread version", async () => {
    const fixture = await createCoachFixture();
    await expect(database.coachTurn.create({ data: {
      ...coachTurnData(fixture.owner.id, fixture.ownerThread.id),
      gateEvidenceJson: { summaryVersion: 1, consentEpoch: 1 },
    } })).rejects.toThrow(/summary.*version/i);
  });

  test("uses Coach invariants for restricted mutation and the authorized frozen-user delete path", async () => {
    const fixture = await createCoachFixture();
    await database.$executeRawUnsafe(
      "GRANT USAGE ON SCHEMA public TO healthos_restricted_app",
    );
    await database.$executeRawUnsafe(
      "GRANT SELECT, UPDATE, DELETE ON coach_threads, coach_turns, coach_messages TO healthos_restricted_app",
    );
    await database.$executeRawUnsafe(
      "GRANT EXECUTE ON FUNCTION healthos_delete_frozen_user(UUID) TO healthos_privacy_worker",
    );

    await expect(database.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE healthos_restricted_app");
      await tx.$executeRaw`UPDATE "coach_threads" SET "summary" = 'mutated' WHERE "id" = ${fixture.ownerThread.id}::uuid`;
    })).rejects.toThrow(/immutable/i);
    await expect(database.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE healthos_restricted_app");
      await tx.$executeRaw`DELETE FROM "coach_threads" WHERE "id" = ${fixture.ownerThread.id}::uuid`;
    })).rejects.toThrow(/immutable/i);

    await database.user.update({
      where: { id: fixture.owner.id },
      data: { status: "deleting", deletedAt: new Date() },
    });
    await database.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE healthos_privacy_worker");
      await tx.$queryRaw`SELECT "healthos_delete_frozen_user"(${fixture.owner.id}::uuid)`;
    });
    expect(await database.coachThread.count({ where: { id: fixture.ownerThread.id } })).toBe(0);
  });

  test("rejects action assignment provenance from an unpublished snapshot", async () => {
    const { snapshot, user } = await createPublishedSnapshot();
    const localDate = new Date("2026-07-10T00:00:00.000Z");
    await expect(
      database.actionAssignment.create({
        data: {
          userId: user.id,
          recommendationSnapshotId: snapshot.id,
          localDate,
          difficulty: "standard",
          status: "active",
          isPrimary: true,
        },
      }),
    ).rejects.toThrow(/provenance/i);
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
        sha256: "a".repeat(64),
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

  test("allows only one current device owner for each APNs token fingerprint", async () => {
    const first = await database.user.create({ data: {} });
    const second = await database.user.create({ data: {} });
    const fingerprint = "f".repeat(64);
    await database.device.create({ data: {
      userId: first.id,
      deviceId: "synthetic-apns-owner-first",
      apnsTokenEncrypted: "synthetic-ciphertext-first",
      apnsTokenFingerprint: fingerprint,
      apnsTokenEpoch: 1,
    } });

    await expect(database.device.create({ data: {
      userId: second.id,
      deviceId: "synthetic-apns-owner-second",
      apnsTokenEncrypted: "synthetic-ciphertext-second",
      apnsTokenFingerprint: fingerprint,
      apnsTokenEpoch: 1,
    } })).rejects.toThrow();
  });

  test("rejects every non-exact external notification template tuple", async () => {
    const user = await database.user.create({ data: { timezone: "UTC", consentEpoch: 1 } });
    await database.consentRecord.create({ data: {
      userId: user.id,
      consentType: "notifications",
      documentVersion: "synthetic-notifications-v1",
      granted: true,
      epoch: 1,
      correlationId: randomUUID(),
      requestHash: randomUUID(),
      source: "synthetic",
    } });
    const device = await database.device.create({ data: {
      userId: user.id,
      deviceId: "synthetic-template-device",
      apnsTokenEncrypted: "synthetic-ciphertext",
      apnsTokenFingerprint: "e".repeat(64),
      apnsTokenEpoch: 1,
    } });
    await database.reminderPreference.create({ data: {
      userId: user.id,
      version: 1,
      enabled: true,
      intensity: "standard",
      quietStartMinute: 1320,
      quietEndMinute: 420,
      advisorMinute: 540,
      behaviorMinute: 900,
      weeklyDay: 1,
      weeklyMinute: 540,
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    } });
    await database.reminderPreferenceRevision.create({ data: {
      userId: user.id,
      version: 1,
      enabled: true,
      intensity: "standard",
      timezone: "UTC",
      quietStartMinute: 1320,
      quietEndMinute: 420,
      advisorMinute: 540,
      behaviorMinute: 900,
      weeklyDay: 1,
      weeklyMinute: 540,
      effectiveAt: new Date("2026-07-01T00:00:00.000Z"),
    } });
    const malformedPayloads = [
      {
        schema_version: { nested: 1 },
        template: "daily_advisor_v1",
        copy_key: "notification.daily_advisor",
        action_key: "open_today",
        deeplink_path: "/today",
      },
      {
        schema_version: 1,
        template: "behavior_reminder_v1",
        copy_key: "notification.behavior_reminder",
        action_key: "open_today",
        deeplink_path: "/today",
      },
      {
        schema_version: 1,
        template: "daily_advisor_v1",
        copy_key: "ZhangSan HbA1c 7.8",
        action_key: "open_today",
        deeplink_path: "/today",
      },
      {
        schema_version: 1,
        template: "daily_advisor_v1",
        copy_key: "notification.daily_advisor",
        action_key: { device_token: "synthetic-secret" },
        deeplink_path: "/today",
      },
      {
        schema_version: 1,
        template: "daily_advisor_v1",
        copy_key: "notification.daily_advisor",
        action_key: "open_today",
        deeplink_path: "/today?user_id=synthetic-user&token=synthetic-secret",
      },
    ];

    for (const [index, payload] of malformedPayloads.entries()) {
      const periodStart = new Date(Date.UTC(2026, 6, 2 + index));
      const scheduledAt = new Date(periodStart.getTime() + 9 * 60 * 60_000);
      const plan = await database.schedulePlan.create({ data: {
        userId: user.id,
        kind: "daily_advisor",
        localDate: periodStart,
        periodStart,
        timezone: "UTC",
        scheduledAt,
        cutoffAt: new Date(scheduledAt.getTime() + 120 * 60_000),
        evaluatedAt: scheduledAt,
        requestedMinute: 540,
        resolvedLocalMinute: 540,
        utcOffsetMinutes: 0,
        preferenceVersion: 1,
        notificationConsentEpoch: null,
        status: "suppressed",
        suppressionReason: "missed_cutoff",
      } });
      await expect(database.channelOutbox.create({ data: {
        userId: user.id,
        channel: "apns",
        template: "daily_advisor_v1",
        payload,
        idempotencyKey: `malformed-template-${index}-${randomUUID()}`,
        destinationId: device.id,
        destinationFingerprint: device.apnsTokenFingerprint,
        destinationEpoch: device.apnsTokenEpoch,
        schedulePlanId: plan.id,
        consentRequirements: { create: { purpose: "notifications", grantEpoch: 1 } },
      } })).rejects.toThrow();
    }
  });

  test("freezes channel outbox identity and append-only delivery evidence while preserving privacy deletion", async () => {
    const user = await database.user.create({ data: {} });
    const outbox = await database.channelOutbox.create({ data: {
      userId: user.id,
      channel: "in_app",
      template: "recommendation_snapshot",
      payload: { recommendation_snapshot_id: randomUUID() },
      idempotencyKey: randomUUID(),
    } });
    await expect(database.channelOutbox.update({
      where: { id: outbox.id },
      data: { payload: { recommendation_snapshot_id: randomUUID() } },
    })).rejects.toThrow(/immutable/i);
    await expect(database.channelOutbox.update({
      where: { id: outbox.id },
      data: { status: "sent" },
    })).rejects.toThrow(/transition/i);

    const leaseToken = randomUUID();
    await database.channelOutbox.update({
      where: { id: outbox.id },
      data: { status: "leased", leaseToken, leaseUntil: new Date(Date.now() + 60_000) },
    });
    await expect(database.channelOutbox.update({
      where: { id: outbox.id },
      data: { leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 120_000) },
    })).rejects.toThrow(/lease/i);
    const attempt = await database.deliveryAttempt.create({ data: {
      outboxId: outbox.id,
      attempt: 1,
      providerMessageId: "synthetic-provider-id",
      status: "sent",
      sentAt: new Date(),
    } });
    await expect(database.deliveryAttempt.update({
      where: { id: attempt.id },
      data: { providerMessageId: "forged-provider-id" },
    })).rejects.toThrow(/append-only/i);
    await expect(database.deliveryAttempt.delete({ where: { id: attempt.id } }))
      .rejects.toThrow(/append-only/i);
    await expect(database.channelOutbox.update({
      where: { id: outbox.id },
      data: { status: "sent" },
    })).rejects.toThrow(/lease token/i);
    const sent = await database.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('healthos.channel_lease_token', ${leaseToken}, true)`;
      return tx.channelOutbox.update({
        where: { id: outbox.id },
        data: { status: "sent" },
      });
    });
    expect(sent.leaseToken).toBeNull();
    expect(sent.leaseUntil).toBeNull();

    const expired = await database.channelOutbox.create({ data: {
      userId: user.id,
      channel: "apns",
      template: "daily_ready",
      payload: { template_data: "synthetic" },
      idempotencyKey: randomUUID(),
    } });
    const expiredToken = randomUUID();
    await database.channelOutbox.update({
      where: { id: expired.id },
      data: {
        status: "leased",
        leaseToken: expiredToken,
        leaseUntil: new Date(Date.now() - 1),
      },
    });
    await expect(database.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('healthos.channel_lease_token', ${expiredToken}, true)`;
      await tx.channelOutbox.update({ where: { id: expired.id }, data: { status: "sent" } });
    })).rejects.toThrow(/expired/i);

    const deliveryUser = await database.user.create({ data: { timezone: "UTC", consentEpoch: 1 } });
    await database.consentRecord.create({ data: {
      userId: deliveryUser.id,
      consentType: "notifications",
      documentVersion: "synthetic-notifications-v1",
      granted: true,
      epoch: 1,
      correlationId: randomUUID(),
      requestHash: randomUUID(),
      source: "synthetic",
    } });
    await database.privacyReconciliation.update({ where: { id: "global" }, data: { status: "ready" } });
    const device = await database.device.create({ data: {
      userId: deliveryUser.id,
      deviceId: "database-fence-ios",
      apnsTokenEncrypted: "synthetic-ciphertext",
      apnsTokenFingerprint: "a".repeat(64),
      apnsTokenEpoch: 1,
      lastSeenAt: new Date(),
    } });
    const scheduledAt = new Date();
    scheduledAt.setUTCSeconds(0, 0);
    const minute = scheduledAt.getUTCHours() * 60 + scheduledAt.getUTCMinutes();
    const preferenceAt = new Date(scheduledAt.getTime() - 60_000);
    const preference = await database.reminderPreference.create({ data: {
      userId: deliveryUser.id,
      version: 1,
      enabled: true,
      intensity: "standard",
      quietStartMinute: (minute + 60) % 1440,
      quietEndMinute: (minute + 120) % 1440,
      advisorMinute: minute,
      behaviorMinute: minute,
      weeklyDay: 1,
      weeklyMinute: 540,
      createdAt: preferenceAt,
      updatedAt: preferenceAt,
    } });
    await database.reminderPreferenceRevision.create({ data: {
      userId: deliveryUser.id,
      version: 1,
      enabled: true,
      intensity: "standard",
      timezone: "UTC",
      quietStartMinute: preference.quietStartMinute,
      quietEndMinute: preference.quietEndMinute,
      advisorMinute: preference.advisorMinute,
      behaviorMinute: preference.behaviorMinute,
      weeklyDay: preference.weeklyDay,
      weeklyMinute: preference.weeklyMinute,
      effectiveAt: preferenceAt,
    } });
    const date = new Date(`${scheduledAt.toISOString().slice(0, 10)}T00:00:00.000Z`);
    const plan = await database.schedulePlan.create({ data: {
      userId: deliveryUser.id,
      kind: "daily_advisor",
      localDate: date,
      periodStart: date,
      timezone: "UTC",
      scheduledAt,
      cutoffAt: new Date(scheduledAt.getTime() + 120 * 60_000),
      evaluatedAt: new Date(),
      requestedMinute: minute,
      resolvedLocalMinute: minute,
      utcOffsetMinutes: 0,
      preferenceVersion: 1,
      notificationConsentEpoch: 1,
      status: "planned",
    } });
    const deliverable = await database.channelOutbox.create({ data: {
      userId: deliveryUser.id,
      channel: "apns",
      template: "daily_advisor_v1",
      payload: {
        schema_version: 1,
        template: "daily_advisor_v1",
        copy_key: "notification.daily_advisor",
        action_key: "open_today",
        deeplink_path: "/today",
      },
      idempotencyKey: randomUUID(),
      destinationId: device.id,
      destinationFingerprint: device.apnsTokenFingerprint,
      destinationEpoch: device.apnsTokenEpoch,
      schedulePlanId: plan.id,
      consentRequirements: { create: { purpose: "notifications", grantEpoch: 1 } },
    } });
    const deliverableLease = randomUUID();
    await database.channelOutbox.update({
      where: { id: deliverable.id },
      data: { status: "leased", leaseToken: deliverableLease, leaseUntil: new Date(Date.now() + 60_000) },
    });
    await expect(database.channelOutbox.update({
      where: { id: deliverable.id }, data: { status: "suppressed" },
    })).rejects.toThrow(/lease/i);
    await database.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('healthos.channel_lease_token', ${deliverableLease}, true)`;
      await tx.channelOutbox.update({ where: { id: deliverable.id }, data: { status: "suppressed" } });
    });

    await database.user.update({
      where: { id: user.id },
      data: { status: "deleting", deletedAt: new Date() },
    });
    await database.$queryRaw`SELECT "healthos_delete_frozen_user"(${user.id}::uuid)`;
    expect(await database.channelOutbox.count({ where: { id: outbox.id } })).toBe(0);
    expect(await database.deliveryAttempt.count({ where: { id: attempt.id } })).toBe(0);
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
