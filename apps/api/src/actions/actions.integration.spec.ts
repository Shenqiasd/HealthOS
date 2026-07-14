import { randomBytes, randomUUID } from "node:crypto";

import { ConflictException, ForbiddenException } from "@nestjs/common";
import type { ActionCode, RiskArea, RuleInput } from "@healthos/rules";
import type { Prisma } from "@prisma/client";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { DatabaseService } from "../database/prisma.service";
import { SessionService } from "../identity/session.service";
import { createApp } from "../main";
import { PublicationRepository } from "../database/publication.repository";
import { RecommendationRunService } from "../recommendations/recommendation-run.service";
import {
  RULES_ENGINE_ARTIFACT_DIGEST,
  RuleBundleService,
} from "../recommendations/rule-bundle.service";
import { TodayService } from "../today/today.service";
import { ActionFeedbackService } from "./action-feedback.service";

const baseRuleInput: RuleInput = {
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

function currentShanghaiDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function atShanghaiNoon(localDate: string): Date {
  return new Date(`${localDate}T04:00:00.000Z`);
}

function nextDate(localDate: string): string {
  return new Date(Date.parse(`${localDate}T00:00:00.000Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
}

describe("action feedback", () => {
  const database = new DatabaseService();
  const bundles = new RuleBundleService(database);
  const runs = new RecommendationRunService(database);
  const publication = new PublicationRepository(database);
  const feedback = new ActionFeedbackService(database);
  const today = new TodayService(database);
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env.APPLE_CLIENT_ID = "synthetic.actions.client";
    process.env.SESSION_SIGNING_SECRET = "synthetic-actions-session-secret-32-characters";
    process.env.APPLE_SUBJECT_HASH_KEY = "synthetic-actions-subject-hash-key";
    process.env.DEVICE_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    await database.$connect();
    app = await createApp();
  });

  beforeEach(async () => {
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
        documentVersion: "synthetic-actions-v1",
        granted: true,
        epoch: 1,
        correlationId: randomUUID(),
        requestHash: randomUUID(),
        source: "synthetic",
      },
    });
    return user;
  }

  async function profileFor(userId: string, ruleInput: RuleInput) {
    const event = await database.profileEvent.create({
      data: {
        userId,
        consentEpoch: 1,
        eventType: "limitation_confirmed",
        source: "synthetic",
        payload: { code: "synthetic", active: ruleInput.mobility_limited },
        payloadHash: randomBytes(32).toString("hex"),
        correlationId: randomUUID(),
      },
    });
    return database.profileSnapshot.create({
      data: {
        userId,
        version: 1,
        consentEpoch: 1,
        factsJson: { limitations: {}, rule_input: ruleInput } as unknown as Prisma.InputJsonObject,
        sourceEventUntil: event.id,
        sourceSequence: event.sequence,
        snapshotHash: randomBytes(32).toString("hex"),
      },
    });
  }

  async function syncedFact(userId: string, localDate: string) {
    const sync = await database.healthSyncRun.create({
      data: {
        userId,
        deviceId: `synthetic-actions-${randomUUID()}`,
        anchorEpoch: 1,
        idempotencyKey: randomUUID(),
        requestHash: randomBytes(32).toString("hex"),
        timezone: "Asia/Shanghai",
        consentEpoch: 1,
        status: "completed",
        completedAt: new Date(`${localDate}T00:01:00.000Z`),
        correlationId: randomUUID(),
      },
    });
    return database.dailyHealthFactRevision.create({
      data: {
        userId,
        localDate: new Date(`${localDate}T00:00:00.000Z`),
        metric: "steps",
        canonicalValueJson: { value: 6000 },
        coverage: 1,
        sourceVectorJson: { synthetic: 1 },
        inputHash: randomBytes(32).toString("hex"),
        healthSyncRunId: sync.id,
        serverSequence: sync.serverSequence,
      },
    });
  }

  async function activeBundle() {
    const draft = await bundles.create(`synthetic-actions-${randomUUID()}`, {
      rules_engine: "deterministic-rules-v1",
      rules_engine_digest: RULES_ENGINE_ARTIFACT_DIGEST,
      safety_bundle_digest: "1".repeat(64),
      localization_bundle_digest: "2".repeat(64),
      template_bundle_digest: "3".repeat(64),
      beta_normal_review_percent: 20,
      rules: [{ code: "synthetic-actions" }],
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

  async function publishedAction(input: {
    actionCode?: "SLEEP_WIND_DOWN" | "SLEEP_WIND_DOWN_LIGHT" | "POST_MEAL_WALK" | "SUGARY_DRINK_SWAP";
    riskArea?: "sleep_recovery" | "fatty_liver" | "uric_acid" | "waist_weight";
    ruleInput?: RuleInput;
  } = {}) {
    const localDate = currentShanghaiDate();
    const actionCode = input.actionCode ?? "SLEEP_WIND_DOWN";
    const riskArea = input.riskArea ?? "sleep_recovery";
    const ruleInput = input.ruleInput ?? baseRuleInput;
    const user = await authorizedUser();
    const profile = await profileFor(user.id, ruleInput);
    const fact = await syncedFact(user.id, localDate);
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
    await database.recommendationRun.update({ where: { id: run.id }, data: { status: "completed" } });
    const renderedPayload = {
      template: "daily_action_v1",
      action_code: actionCode,
      safety_class: "normal",
      risk_area: riskArea,
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
        riskArea,
        actionCode,
        reasonCode: "ACTION_SELECTED",
      },
      rule_key: `${riskArea}:${actionCode}`,
    };
    const draft = await database.recommendationSnapshot.create({
      data: {
        runId: run.id,
        revision: 1,
        riskArea,
        safetyClass: "normal",
        actionCode,
        renderedPayloadJson: renderedPayload,
        canonicalRuleInputJson: ruleInput as unknown as Prisma.InputJsonObject,
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
        reasonCode: "SYNTHETIC_ACTION_REVIEW",
      },
    });
    const result = await publication.publishReviewed({
      draftSnapshotId: draft.id,
      actorId: "synthetic-action-reviewer",
      reasonCode: "SYNTHETIC_ACTION_APPROVAL",
    });
    const action = await database.actionAssignment.findUniqueOrThrow({
      where: { id: result.manifest.actionAssignmentId! },
    });
    return { action, bundle, fact, profile, run, snapshot: result.snapshot, user };
  }

  function command(
    expectedVersion: number,
    actionCommand: "complete" | "skip" | "lighter" | "swap",
    reasonCode?: "too_hard" | "no_time" | "tired" | "uncomfortable" | "weather" | "neutral",
    idempotencyKey = randomUUID(),
  ) {
    return {
      command: actionCommand,
      expectedVersion,
      idempotencyKey,
      ...(reasonCode ? { reasonCode } : {}),
    };
  }

  test("completes once and exact offline replay returns the original result", async () => {
    const fixture = await publishedAction();
    const input = command(1, "complete");
    const first = await feedback.apply(fixture.user.id, fixture.action.id, randomUUID(), input);
    const replay = await feedback.apply(fixture.user.id, fixture.action.id, randomUUID(), input);

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      schema_version: 1,
      outcome: "completed",
      original_action: { id: fixture.action.id, status: "completed", version: 2 },
      current_action: null,
    });
    await expect(database.feedbackEvent.count()).resolves.toBe(1);
    await expect(feedback.apply(
      fixture.user.id,
      fixture.action.id,
      randomUUID(),
      { ...input, command: "skip", reasonCode: "neutral" },
    )).rejects.toBeInstanceOf(ConflictException);
    await expect(feedback.apply(
      fixture.user.id,
      fixture.action.id,
      randomUUID(),
      command(1, "complete"),
    )).rejects.toBeInstanceOf(ConflictException);
  });

  test.each(["no_time", "tired", "uncomfortable", "weather", "neutral"] as const)(
    "records one immutable %s skip reason",
    async (reasonCode) => {
      const fixture = await publishedAction();
      const result = await feedback.apply(
        fixture.user.id,
        fixture.action.id,
        randomUUID(),
        command(1, "skip", reasonCode),
      );
      expect(result).toMatchObject({ outcome: "skipped", reason_code: reasonCode });
      await expect(database.feedbackEvent.findFirstOrThrow()).resolves.toMatchObject({
        type: "skip",
        reasonCode,
      });
    },
  );

  test("creates one lighter replacement, preserves the old assignment, and updates Today", async () => {
    const fixture = await publishedAction();
    const result = await feedback.apply(
      fixture.user.id,
      fixture.action.id,
      randomUUID(),
      command(1, "lighter", "too_hard"),
    );
    expect(result).toMatchObject({
      outcome: "replaced",
      original_action: { status: "replaced", version: 2 },
      current_action: { code: "SLEEP_WIND_DOWN_LIGHT", status: "active", version: 2 },
    });
    const original = await database.actionAssignment.findUniqueOrThrow({ where: { id: fixture.action.id } });
    expect(original.replacedById).toBe(result.current_action?.id);
    await expect(database.actionAssignment.count({ where: { userId: fixture.user.id } })).resolves.toBe(2);
    const view = await today.get(
      fixture.user.id,
      randomUUID(),
      atShanghaiNoon(fixture.action.localDate.toISOString().slice(0, 10)),
    );
    expect(view).toMatchObject({
      state: "active_action",
      action: { id: result.current_action?.id, code: "SLEEP_WIND_DOWN_LIGHT", difficulty: "light" },
    });
  });

  test("uses deterministic rule reevaluation for a safe explicit swap", async () => {
    const ruleInput: RuleInput = {
      ...baseRuleInput,
      signals: { fatty_liver: "elevated" },
    };
    const fixture = await publishedAction({
      actionCode: "POST_MEAL_WALK",
      riskArea: "fatty_liver",
      ruleInput,
    });
    const before = await today.get(
      fixture.user.id,
      randomUUID(),
      atShanghaiNoon(fixture.action.localDate.toISOString().slice(0, 10)),
    );
    expect(before.action?.commands.lighter).toBe(false);
    const result = await feedback.apply(
      fixture.user.id,
      fixture.action.id,
      randomUUID(),
      command(1, "swap", "weather"),
    );
    expect(result).toMatchObject({
      outcome: "replaced",
      current_action: { code: "SUGARY_DRINK_SWAP", difficulty: "light" },
    });
  });

  const noAlternativeCases: Array<[string, ActionCode, RiskArea, RuleInput, "lighter" | "swap"]> = [
    ["unavailable lighter", "SUGARY_DRINK_SWAP", "uric_acid", { ...baseRuleInput, signals: { uric_acid: "elevated" } }, "lighter"],
    ["no safe swap", "POST_MEAL_WALK", "fatty_liver", { ...baseRuleInput, signals: { fatty_liver: "elevated" }, rejected_action_codes: ["SUGARY_DRINK_SWAP"] }, "swap"],
    ["swap that would masquerade as lighter", "SLEEP_WIND_DOWN", "sleep_recovery", baseRuleInput, "swap"],
  ];
  test.each(noAlternativeCases)("records a neutral skip for %s", async (_label, actionCode, riskArea, ruleInput, actionCommand) => {
    const fixture = await publishedAction({ actionCode, riskArea, ruleInput });
    const result = await feedback.apply(
      fixture.user.id,
      fixture.action.id,
      randomUUID(),
      command(1, actionCommand, "too_hard"),
    );
    expect(result).toMatchObject({
      outcome: "no_safe_alternative",
      original_action: { status: "skipped", version: 2 },
      current_action: null,
      recovery_key: "action.feedback.no_safe_alternative",
    });
    await expect(database.actionAssignment.count({ where: { userId: fixture.user.id } })).resolves.toBe(1);
  });

  test("serializes rapid exact duplicate taps into one feedback and one replacement", async () => {
    const fixture = await publishedAction();
    const input = command(1, "lighter", "too_hard");
    const results = await Promise.all([
      feedback.apply(fixture.user.id, fixture.action.id, randomUUID(), input),
      feedback.apply(fixture.user.id, fixture.action.id, randomUUID(), input),
    ]);
    expect(results[0]).toEqual(results[1]);
    await expect(database.feedbackEvent.count()).resolves.toBe(1);
    await expect(database.actionAssignment.count({ where: { userId: fixture.user.id } })).resolves.toBe(2);
  });

  test("scopes an idempotency key to the user across the whole replacement chain", async () => {
    const fixture = await publishedAction();
    const input = command(1, "lighter", "too_hard");
    const first = await feedback.apply(fixture.user.id, fixture.action.id, randomUUID(), input);
    await expect(feedback.apply(
      fixture.user.id,
      first.current_action!.id,
      randomUUID(),
      {
        command: "swap",
        reasonCode: "weather",
        expectedVersion: first.current_action!.version,
        idempotencyKey: input.idempotencyKey,
      },
    )).rejects.toThrow(/idempotency/i);
    await expect(database.feedbackEvent.count()).resolves.toBe(1);
    await expect(database.actionAssignment.count({ where: { userId: fixture.user.id } })).resolves.toBe(2);
  });

  test("never cycles a replacement chain back to an earlier action code", async () => {
    const ruleInput: RuleInput = {
      ...baseRuleInput,
      signals: { fatty_liver: "elevated" },
    };
    const fixture = await publishedAction({
      actionCode: "POST_MEAL_WALK",
      riskArea: "fatty_liver",
      ruleInput,
    });
    const first = await feedback.apply(
      fixture.user.id,
      fixture.action.id,
      randomUUID(),
      command(1, "swap", "weather"),
    );
    expect(first.current_action?.code).toBe("SUGARY_DRINK_SWAP");
    const second = await feedback.apply(
      fixture.user.id,
      first.current_action!.id,
      randomUUID(),
      command(first.current_action!.version, "swap", "weather"),
    );
    expect(second).toMatchObject({
      outcome: "no_safe_alternative",
      original_action: { code: "SUGARY_DRINK_SWAP", status: "skipped" },
      current_action: null,
    });
    const codes = await database.actionAssignment.findMany({
      where: { userId: fixture.user.id },
      select: { actionCode: true },
    });
    expect(codes.map((entry) => entry.actionCode).sort()).toEqual([
      "POST_MEAL_WALK",
      "SUGARY_DRINK_SWAP",
    ]);
  });

  test("rejects cross-user, stale-version, withdrawn-consent, and non-ready privacy mutations", async () => {
    const fixture = await publishedAction();
    const other = await authorizedUser();
    await expect(feedback.apply(other.id, fixture.action.id, randomUUID(), command(1, "complete")))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(feedback.apply(fixture.user.id, fixture.action.id, randomUUID(), command(99, "complete")))
      .rejects.toBeInstanceOf(ConflictException);

    await database.consentRecord.create({
      data: {
        userId: fixture.user.id,
        consentType: "health_processing",
        documentVersion: "synthetic-actions-v2",
        granted: false,
        epoch: 2,
        correlationId: randomUUID(),
        requestHash: randomUUID(),
        source: "synthetic",
      },
    });
    await expect(feedback.apply(fixture.user.id, fixture.action.id, randomUUID(), command(1, "complete")))
      .rejects.toBeInstanceOf(ForbiddenException);

    await database.$executeRawUnsafe(`
      TRUNCATE TABLE users, rule_bundles, audit_logs, privacy_reconciliation
      RESTART IDENTITY CASCADE
    `);
    await database.privacyReconciliation.create({ data: { id: "global", status: "ready" } });
    const privacy = await publishedAction();
    await database.privacyReconciliation.update({ where: { id: "global" }, data: { status: "failed" } });
    await expect(feedback.apply(privacy.user.id, privacy.action.id, randomUUID(), command(1, "complete")))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  test("database triggers reject state/version jumps and feedback mutation", async () => {
    const fixture = await publishedAction();
    const other = await authorizedUser();
    const identityMutations = [
      { userId: other.id },
      { recommendationSnapshotId: randomUUID() },
      { localDate: new Date(`${nextDate(fixture.action.localDate.toISOString().slice(0, 10))}T00:00:00.000Z`) },
      { difficulty: "light" },
      { isPrimary: false },
      { actionCode: "SLEEP_WIND_DOWN_LIGHT" },
    ];
    for (const data of identityMutations) {
      await expect(database.actionAssignment.update({
        where: { id: fixture.action.id },
        data,
      })).rejects.toThrow(/immutable/i);
    }
    await expect(database.feedbackEvent.create({
      data: {
        userId: fixture.user.id,
        actionAssignmentId: fixture.action.id,
        type: "complete",
        reasonCode: "weather",
        source: "ios",
        idempotencyKey: randomUUID(),
        requestHash: "a".repeat(64),
        resultJson: {},
      },
    })).rejects.toThrow(/command|reason/i);
    await expect(database.actionAssignment.update({
      where: { id: fixture.action.id },
      data: { status: "completed" },
    })).rejects.toThrow(/version/i);
    await expect(database.actionAssignment.update({
      where: { id: fixture.action.id },
      data: { version: { increment: 2 }, status: "completed" },
    })).rejects.toThrow(/version/i);

    const result = await feedback.apply(
      fixture.user.id,
      fixture.action.id,
      randomUUID(),
      command(1, "complete"),
    );
    await expect(database.actionAssignment.create({
      data: {
        userId: fixture.user.id,
        recommendationSnapshotId: fixture.snapshot.id,
        localDate: fixture.action.localDate,
        actionCode: fixture.action.actionCode,
        difficulty: fixture.action.difficulty,
        status: "active",
        isPrimary: true,
      },
    })).rejects.toThrow();
    await expect(database.actionAssignment.update({
      where: { id: fixture.action.id },
      data: { version: { increment: 1 }, status: "active" },
    })).rejects.toThrow(/transition/i);
    await expect(database.feedbackEvent.update({
      where: { id: result.feedback_event_id },
      data: { reasonCode: "neutral" },
    })).rejects.toThrow(/append-only/i);
  });

  test("rejects an orphan replacement proposal when its transaction commits", async () => {
    const fixture = await publishedAction();

    await expect(database.$transaction(async (tx) => {
      await tx.actionAssignment.create({
        data: {
          userId: fixture.user.id,
          recommendationSnapshotId: fixture.snapshot.id,
          localDate: fixture.action.localDate,
          actionCode: "SLEEP_WIND_DOWN_LIGHT",
          difficulty: "light",
          status: "proposed",
          isPrimary: true,
        },
      });
    })).rejects.toThrow(/proposal|action chain/i);

    await expect(database.actionAssignment.count({
      where: { userId: fixture.user.id },
    })).resolves.toBe(1);
    const view = await today.get(
      fixture.user.id,
      randomUUID(),
      atShanghaiNoon(fixture.action.localDate.toISOString().slice(0, 10)),
    );
    expect(view).toMatchObject({
      state: "active_action",
      action: { id: fixture.action.id, code: fixture.action.actionCode },
    });
  });

  test("rejects activating a replacement without linking its predecessor", async () => {
    const fixture = await publishedAction();

    await expect(database.$transaction(async (tx) => {
      const replacement = await tx.actionAssignment.create({
        data: {
          userId: fixture.user.id,
          recommendationSnapshotId: fixture.snapshot.id,
          localDate: fixture.action.localDate,
          actionCode: "SLEEP_WIND_DOWN_LIGHT",
          difficulty: "light",
          status: "proposed",
          isPrimary: true,
        },
      });
      await tx.actionAssignment.update({
        where: { id: fixture.action.id },
        data: { status: "completed", version: { increment: 1 } },
      });
      await tx.actionAssignment.update({
        where: { id: replacement.id },
        data: { status: "active", version: { increment: 1 } },
      });
    })).rejects.toThrow(/predecessor/i);

    await expect(database.actionAssignment.count({
      where: { userId: fixture.user.id },
    })).resolves.toBe(1);
  });

  test("rejects replacing an action unless its target is active at commit", async () => {
    const fixture = await publishedAction();

    await expect(database.$transaction(async (tx) => {
      const replacement = await tx.actionAssignment.create({
        data: {
          userId: fixture.user.id,
          recommendationSnapshotId: fixture.snapshot.id,
          localDate: fixture.action.localDate,
          actionCode: "SLEEP_WIND_DOWN_LIGHT",
          difficulty: "light",
          status: "proposed",
          isPrimary: true,
        },
      });
      await tx.actionAssignment.update({
        where: { id: fixture.action.id },
        data: {
          status: "replaced",
          replacedById: replacement.id,
          version: { increment: 1 },
        },
      });
    })).rejects.toThrow(/proposal|active replacement/i);

    await expect(database.actionAssignment.count({
      where: { userId: fixture.user.id },
    })).resolves.toBe(1);
  });

  test("exact privacy deletion removes action and immutable feedback history", async () => {
    const fixture = await publishedAction();
    await feedback.apply(
      fixture.user.id,
      fixture.action.id,
      randomUUID(),
      command(1, "skip", "neutral"),
    );
    await database.user.update({
      where: { id: fixture.user.id },
      data: { status: "deleting", deletedAt: new Date() },
    });
    await database.$queryRaw`SELECT "healthos_delete_frozen_user"(${fixture.user.id}::uuid)`;
    await expect(database.user.count({ where: { id: fixture.user.id } })).resolves.toBe(0);
    await expect(database.actionAssignment.count({ where: { userId: fixture.user.id } })).resolves.toBe(0);
    await expect(database.feedbackEvent.count()).resolves.toBe(0);
  });

  test("protects the HTTP route and validates the canonical feedback body", async () => {
    const fixture = await publishedAction();
    const unauthorized = await app.inject({
      method: "POST",
      url: `/actions/${fixture.action.id}/feedback`,
      payload: {
        command: "complete",
        expected_version: 1,
        idempotency_key: randomUUID(),
      },
    });
    expect(unauthorized.statusCode).toBe(401);

    const sessions = app.get(SessionService);
    const tokens = await sessions.issue(fixture.user.id);
    const malformed = await app.inject({
      method: "POST",
      url: `/actions/${fixture.action.id}/feedback`,
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      payload: {
        command: "lighter",
        reason_code: "unsupported",
        expected_version: 0,
        idempotency_key: "not-a-uuid",
      },
    });
    expect(malformed.statusCode).toBe(400);

    for (const payload of [
      { command: "complete", reason_code: "neutral" },
      { command: "skip" },
      { command: "lighter", reason_code: "weather" },
    ]) {
      const invalidCombination = await app.inject({
        method: "POST",
        url: `/actions/${fixture.action.id}/feedback`,
        headers: { authorization: `Bearer ${tokens.accessToken}` },
        payload: {
          ...payload,
          expected_version: 1,
          idempotency_key: randomUUID(),
        },
      });
      expect(invalidCombination.statusCode).toBe(400);
    }
    await expect(database.feedbackEvent.count()).resolves.toBe(0);

    const idempotencyKey = randomUUID();
    const accepted = await app.inject({
      method: "POST",
      url: `/actions/${fixture.action.id}/feedback`,
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        "x-correlation-id": randomUUID(),
      },
      payload: {
        command: "complete",
        expected_version: 1,
        idempotency_key: idempotencyKey,
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      schema_version: 1,
      idempotency_key: idempotencyKey,
      outcome: "completed",
      original_action: { id: fixture.action.id, version: 2, status: "completed" },
    });
  });

  test("rejects non-current, non-primary, and incident-withdrawn actions", async () => {
    const fixture = await publishedAction();
    await expect(feedback.apply(
      fixture.user.id,
      fixture.action.id,
      randomUUID(),
      command(1, "complete"),
      atShanghaiNoon(nextDate(fixture.action.localDate.toISOString().slice(0, 10))),
    )).rejects.toBeInstanceOf(ConflictException);

    await expect(database.actionAssignment.create({
      data: {
        userId: fixture.user.id,
        recommendationSnapshotId: fixture.snapshot.id,
        localDate: fixture.action.localDate,
        actionCode: fixture.action.actionCode,
        difficulty: "standard",
        status: "active",
        isPrimary: false,
      },
    })).rejects.toThrow(/provenance/i);

    await database.safetyIncident.create({
      data: {
        userId: fixture.user.id,
        source: "rule:sleep_recovery:SLEEP_WIND_DOWN",
        severity: "high",
        detailsEncrypted: "synthetic-ciphertext",
      },
    });
    await expect(feedback.apply(
      fixture.user.id,
      fixture.action.id,
      randomUUID(),
      command(1, "complete"),
      atShanghaiNoon(fixture.action.localDate.toISOString().slice(0, 10)),
    )).rejects.toBeInstanceOf(ConflictException);
  });
});
