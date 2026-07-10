import { randomUUID } from "node:crypto";

import { DatabaseService } from "../database/prisma.service";
import { PublicationRepository } from "../database/publication.repository";
import { RecommendationRunService } from "./recommendation-run.service";
import { RULES_ENGINE_ARTIFACT_DIGEST, RuleBundleService } from "./rule-bundle.service";

describe("recommendation runs and rule bundles", () => {
  const database = new DatabaseService();
  const bundles = new RuleBundleService(database);
  const runs = new RecommendationRunService(database);
  const publication = new PublicationRepository(database);
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

  beforeAll(async () => database.$connect());
  afterAll(async () => database.$disconnect());
  afterEach(async () => {
    await database.$executeRawUnsafe(`
      TRUNCATE TABLE users, rule_bundles, audit_logs, privacy_reconciliation
      RESTART IDENTITY CASCADE
    `);
    await database.privacyReconciliation.create({ data: { id: "global", status: "ready" } });
  });

  async function approvedBundle(version: string) {
    const draft = await bundles.create(version, {
      rules_engine: "deterministic-rules-v1",
      rules_engine_digest: RULES_ENGINE_ARTIFACT_DIGEST,
      safety_bundle_digest: "1".repeat(64),
      localization_bundle_digest: "2".repeat(64),
      template_bundle_digest: "3".repeat(64),
      beta_normal_review_percent: 20,
      rules: [{ code: "synthetic-rule", version }],
    });
    const technical = await bundles.approve(draft.id, {
      role: "technical",
      actorId: `Synthetic-Tech-${version}`,
      approvedAt: new Date("2026-07-11T00:00:00.000Z"),
    });
    expect(technical.status).toBe("approval_pending");
    const approved = await bundles.approve(draft.id, {
      role: "medical",
      actorId: `Synthetic-Medical-${version}`,
      approvedAt: new Date("2026-07-11T00:01:00.000Z"),
    });
    expect(approved.status).toBe("approved_not_published");
    return approved;
  }

  async function authorizedProfile() {
    const user = await database.user.create({ data: { consentEpoch: 1 } });
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
        consentEpoch: 1,
        factsJson: { daily_health: {}, labs: {}, limitations: {}, rule_input: ruleInput },
        sourceEventUntil: event.id,
        sourceSequence: event.sequence,
        snapshotHash: "b".repeat(64),
      },
    });
    return { user, profile };
  }

  async function reviewDraft(slaAt: Date) {
    const bundle = await approvedBundle(`synthetic-review-${randomUUID()}`);
    await bundles.activate(bundle.id, "synthetic-release-owner", false);
    const { user, profile } = await authorizedProfile();
    const run = await runs.request({
      userId: user.id,
      localDate: "2026-07-11",
      profileSnapshotId: profile.id,
      ruleInput,
      factRevisionIds: [],
      labObservationIds: [],
      correlationId: randomUUID(),
    });
    await database.recommendationRun.update({ where: { id: run.id }, data: { status: "completed" } });
    const provenance = {
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
      rule_result: { outcome: "action", safetyClass: "normal", actionCode: "SLEEP_WIND_DOWN", riskArea: "sleep_recovery" },
      rule_key: "sleep_recovery:SLEEP_WIND_DOWN",
    };
    const draft = await database.recommendationSnapshot.create({
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
        canonicalRuleInputJson: ruleInput,
        provenanceJson: provenance,
        reviewStatus: "review_required",
        releaseStage: "alpha",
        reviewRoute: "review_required",
        policyDigest: "f".repeat(64),
      },
    });
    await database.recommendationReviewEvent.create({ data: { snapshotId: draft.id, eventType: "submitted" } });
    await database.recommendationReviewTask.create({
      data: { snapshotId: draft.id, priority: "normal", slaAt, reasonCode: "ALPHA_REVIEW" },
    });
    return { bundle, draft, run, user };
  }

  test("binds two distinct approvals to content and records rollback evidence", async () => {
    const first = await approvedBundle("synthetic-v1");
    await expect(bundles.approve(first.id, {
      role: "technical",
      actorId: "another-tech",
      approvedAt: new Date(),
    })).rejects.toThrow();
    await bundles.activate(first.id, "synthetic-release-owner", false);

    const second = await approvedBundle("synthetic-v2");
    await bundles.activate(second.id, "synthetic-release-owner", true);
    expect((await database.ruleBundle.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("superseded");
    const rollback = await bundles.rollback(second.id, first.id, "synthetic-release-owner", "SAFETY_ROLLBACK");
    expect(rollback.restored.id).toBe(first.id);
    expect(await database.ruleBundleRollbackEvent.count()).toBe(1);
    expect((await database.ruleBundle.findUniqueOrThrow({ where: { id: second.id } })).status).toBe("rolled_back");
  });

  test("rejects one normalized actor filling both approval roles", async () => {
    const draft = await bundles.create("synthetic-distinct-actors", {
      rules_engine: "deterministic-rules-v1",
      rules_engine_digest: RULES_ENGINE_ARTIFACT_DIGEST,
      safety_bundle_digest: "1".repeat(64),
      localization_bundle_digest: "2".repeat(64),
      template_bundle_digest: "3".repeat(64),
      beta_normal_review_percent: 20,
      rules: [{ code: "synthetic-distinct" }],
    });
    await bundles.approve(draft.id, {
      role: "technical",
      actorId: " Same-Actor ",
      approvedAt: new Date("2026-07-11T00:00:00.000Z"),
    });
    await expect(bundles.approve(draft.id, {
      role: "medical",
      actorId: "same-actor",
      approvedAt: new Date("2026-07-11T00:01:00.000Z"),
    })).rejects.toThrow();
    expect((await database.ruleBundle.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("approval_pending");
  });

  test("creates one consent-bound daily run and treats exact retries idempotently", async () => {
    const bundle = await approvedBundle("synthetic-daily-v1");
    await bundles.activate(bundle.id, "synthetic-release-owner", false);
    const { user, profile } = await authorizedProfile();
    const request = {
      userId: user.id,
      localDate: "2026-07-11",
      profileSnapshotId: profile.id,
      ruleInput,
      factRevisionIds: [],
      labObservationIds: [],
      correlationId: randomUUID(),
    };
    const first = await runs.request(request);
    const retry = await runs.request({ ...request, correlationId: randomUUID() });
    expect(retry.id).toBe(first.id);
    expect(await database.recommendationRun.count()).toBe(1);
    expect(await database.domainOutbox.count({ where: { eventType: "recommendation.run.requested" } })).toBe(1);
    await expect(runs.request({
      ...request,
      correlationId: randomUUID(),
      ruleInput: { ...request.ruleInput, acute_symptoms: true },
    })).rejects.toThrow(/profile projection/i);
  });

  test("rejects a manifest whose rule input is not the immutable profile projection", async () => {
    const bundle = await approvedBundle("synthetic-forged-manifest-v1");
    await bundles.activate(bundle.id, "synthetic-release-owner", false);
    const { user, profile } = await authorizedProfile();
    await expect(database.recommendationRun.create({
      data: {
        userId: user.id,
        localDate: new Date("2026-07-12T00:00:00.000Z"),
        inputSnapshotId: profile.id,
        ruleBundleId: bundle.id,
        consentEpoch: 1,
        inputManifestJson: {
          profile_snapshot_id: profile.id,
          profile_snapshot_hash: profile.snapshotHash,
          consent_epoch: 1,
          rule_input: { ...ruleInput, acute_symptoms: true },
          fact_inputs: [],
          lab_inputs: [],
          rule_bundle_id: bundle.id,
          rule_bundle_digest: bundle.bundleDigest,
        },
        correlationId: randomUUID(),
      },
    })).rejects.toThrow(/manifest.*source rows/i);
  });

  test("revalidates the manifest when a sidecar is inserted after run constraints were forced immediate", async () => {
    const bundle = await approvedBundle("synthetic-sidecar-order-v1");
    await bundles.activate(bundle.id, "synthetic-release-owner", false);
    const { user, profile } = await authorizedProfile();
    const fact = await database.dailyHealthFactRevision.create({
      data: {
        userId: user.id,
        localDate: new Date("2026-07-11T00:00:00.000Z"),
        metric: "steps",
        canonicalValueJson: { value: 5000 },
        sourceVectorJson: { device: "synthetic" },
        inputHash: "4".repeat(64),
      },
    });
    await expect(database.$transaction(async (tx) => {
      const run = await tx.recommendationRun.create({
        data: {
          userId: user.id,
          localDate: new Date("2026-07-12T00:00:00.000Z"),
          inputSnapshotId: profile.id,
          ruleBundleId: bundle.id,
          consentEpoch: 1,
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
          correlationId: randomUUID(),
        },
      });
      await tx.$executeRawUnsafe("SET CONSTRAINTS recommendation_runs_manifest_binding IMMEDIATE");
      await tx.recommendationRunFactInput.create({
        data: { runId: run.id, factRevisionId: fact.id, inputHash: fact.inputHash },
      });
    })).rejects.toThrow(/manifest.*source rows/i);
  });

  test("pins exact daily fact and usable same-user lab revisions for replay", async () => {
    const bundle = await approvedBundle("synthetic-provenance-v1");
    await bundles.activate(bundle.id, "synthetic-release-owner", false);
    const { user, profile } = await authorizedProfile();
    const fact = await database.dailyHealthFactRevision.create({
      data: {
        userId: user.id,
        localDate: new Date("2026-07-11T00:00:00.000Z"),
        metric: "steps",
        canonicalValueJson: { value: 7200 },
        coverage: 1,
        sourceVectorJson: { device: "synthetic" },
        inputHash: "1".repeat(64),
      },
    });
    const document = await database.labDocument.create({
      data: { userId: user.id, objectKey: "synthetic/report.pdf", sha256: "2".repeat(64), status: "completed" },
    });
    const observation = await database.labObservation.create({
      data: {
        documentId: document.id,
        code: "URIC_ACID",
        value: "390",
        unit: "umol/L",
        evidenceBox: { page: 1 },
        confidence: 1,
        confirmationStatus: "usable",
      },
    });
    const run = await runs.request({
      userId: user.id,
      localDate: "2026-07-11",
      profileSnapshotId: profile.id,
      ruleInput,
      factRevisionIds: [fact.id],
      labObservationIds: [observation.id],
      correlationId: randomUUID(),
    });
    expect(await database.recommendationRunFactInput.count({ where: { runId: run.id } })).toBe(1);
    expect(await database.recommendationRunLabInput.count({ where: { runId: run.id } })).toBe(1);
    expect((await database.recommendationRunLabInput.findFirstOrThrow({ where: { runId: run.id } })).observationHash)
      .toMatch(/^[a-f0-9]{64}$/);
  });

  test("rejects an older profile version from the same consent epoch", async () => {
    const bundle = await approvedBundle("synthetic-current-profile-v1");
    await bundles.activate(bundle.id, "synthetic-release-owner", false);
    const { user, profile } = await authorizedProfile();
    const laterEvent = await database.profileEvent.create({
      data: {
        userId: user.id,
        consentEpoch: 1,
        eventType: "limitation_confirmed",
        source: "synthetic",
        payload: { code: "knee_discomfort", active: true },
        payloadHash: "c".repeat(64),
        correlationId: randomUUID(),
      },
    });
    await database.profileSnapshot.create({
      data: {
        userId: user.id,
        version: 2,
        consentEpoch: 1,
        factsJson: { daily_health: {}, labs: {}, limitations: { knee_discomfort: { active: true } }, rule_input: ruleInput },
        sourceEventUntil: laterEvent.id,
        sourceSequence: laterEvent.sequence,
        snapshotHash: "d".repeat(64),
      },
    });
    await expect(runs.request({
      userId: user.id,
      localDate: "2026-07-11",
      profileSnapshotId: profile.id,
      ruleInput,
      factRevisionIds: [],
      labObservationIds: [],
      correlationId: randomUUID(),
    })).rejects.toThrow(/current user consent/i);
  });

  test("publishes an approved edit as a new immutable revision with one atomic manifest", async () => {
    const { draft } = await reviewDraft(new Date(Date.now() + 60_000));
    const result = await publication.publishReviewed({
      draftSnapshotId: draft.id,
      actorId: "synthetic-reviewer",
      reasonCode: "COPY_CLARITY",
      renderedPayload: {
        template: "daily_action_v1",
        action_code: "SLEEP_WIND_DOWN",
        safety_class: "normal",
        risk_area: "sleep_recovery",
        copy_key: "review.edited-safe-copy",
      },
    });
    expect(result.snapshot.revision).toBe(2);
    expect(result.snapshot.supersedesId).toBe(draft.id);
    expect(await database.recommendationSnapshot.count({ where: { runId: draft.runId } })).toBe(2);
    expect(await database.recommendationReviewEvent.count({ where: { snapshotId: result.snapshot.id } })).toBe(2);
    expect(await database.recommendationPublication.count()).toBe(1);
    expect(await database.channelOutbox.count()).toBe(1);
    await expect(database.recommendationSnapshot.update({
      where: { id: draft.id },
      data: { actionCode: "SLEEP_WIND_DOWN_LIGHT" },
    })).rejects.toThrow(/immutable|append-only/i);
  });

  test("rejects missed-SLA review without creating a partial revision", async () => {
    const { draft } = await reviewDraft(new Date(Date.now() - 1_000));
    await expect(publication.publishReviewed({
      draftSnapshotId: draft.id,
      actorId: "synthetic-reviewer",
      reasonCode: "LATE_REVIEW",
    })).rejects.toThrow(/SLA/i);
    expect(await database.recommendationSnapshot.count({ where: { runId: draft.runId } })).toBe(1);
    expect(await database.recommendationPublication.count()).toBe(0);
  });

  test("rejects a reviewer payload that changes the deterministic action contract", async () => {
    const { draft } = await reviewDraft(new Date(Date.now() + 60_000));
    await expect(publication.publishReviewed({
      draftSnapshotId: draft.id,
      actorId: "synthetic-reviewer",
      reasonCode: "UNSAFE_EDIT",
      renderedPayload: {
        template: "daily_action_v1",
        action_code: "SUGARY_DRINK_SWAP",
        safety_class: "normal",
        risk_area: "sleep_recovery",
        copy_key: "review.unsafe",
      },
    })).rejects.toThrow(/deterministic output contract/i);
    expect(await database.recommendationSnapshot.count({ where: { runId: draft.runId } })).toBe(1);
  });

  test("rejects review publication when a newer profile snapshot exists", async () => {
    const { draft, user } = await reviewDraft(new Date(Date.now() + 60_000));
    const event = await database.profileEvent.create({
      data: {
        userId: user.id,
        consentEpoch: 1,
        eventType: "limitation_confirmed",
        source: "synthetic",
        payload: { code: "new_limitation", active: true },
        payloadHash: "7".repeat(64),
        correlationId: randomUUID(),
      },
    });
    await database.profileSnapshot.create({
      data: {
        userId: user.id,
        version: 2,
        consentEpoch: 1,
        factsJson: { limitations: { new_limitation: { active: true } }, rule_input: ruleInput },
        sourceEventUntil: event.id,
        sourceSequence: event.sequence,
        snapshotHash: "6".repeat(64),
      },
    });
    await expect(publication.publishReviewed({
      draftSnapshotId: draft.id,
      actorId: "synthetic-reviewer",
      reasonCode: "STALE_PROFILE",
    })).rejects.toThrow(/authorization changed/i);
    expect(await database.recommendationPublication.count()).toBe(0);
  });
});
