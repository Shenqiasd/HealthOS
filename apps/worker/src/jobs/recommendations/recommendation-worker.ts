import { createHash, randomUUID } from "node:crypto";

import { evaluateRule, getAction, isRuleInput } from "@healthos/rules";
import { RecommendationReviewEventType, RecommendationReviewStatus, type Prisma, type PrismaClient } from "@prisma/client";

import { WorkerTelemetry } from "../../telemetry/worker-telemetry";

export const RULES_ENGINE_ARTIFACT_DIGEST = "22e19a3848877f16f3a56921f91f8eb1f3a54f21551d3c47569153f748c8d282";

export interface RecommendationWorkerPolicy {
  releaseStage: "alpha" | "beta";
  normalSamplePercent: number;
  llmEnabled: boolean;
  leaseSeconds: number;
  reviewSlaSeconds: number;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function samplingBucket(userId: string, localDate: string, signal: string | null): number {
  return createHash("sha256").update(`${userId}:${localDate}:${signal ?? "none"}`).digest().readUInt32BE(0) % 100;
}

export class RecommendationWorker {
  constructor(
    private readonly database: PrismaClient,
    private readonly policy: RecommendationWorkerPolicy,
    private readonly telemetry: WorkerTelemetry = new WorkerTelemetry(),
  ) {}

  async claim(runId: string) {
    const now = new Date();
    const leaseToken = randomUUID();
    const claimed = await this.database.recommendationRun.updateMany({
      where: {
        id: runId,
        OR: [
          { status: { in: ["pending", "failed"] } },
          { status: "active", leaseUntil: { lt: now } },
        ],
      },
      data: {
        status: "active",
        attempt: { increment: 1 },
        leaseToken,
        leaseUntil: new Date(now.getTime() + this.policy.leaseSeconds * 1_000),
      },
    });
    if (claimed.count !== 1) throw new Error("Recommendation run is not claimable");
    return this.database.recommendationRun.findUniqueOrThrow({ where: { id: runId } });
  }

  async process(runId: string, leaseToken: string) {
    if (this.policy.releaseStage === "beta" && this.policy.normalSamplePercent < 20) {
      throw new Error("Beta review sampling cannot be below 20 percent");
    }
    const existing = await this.database.recommendationRun.findUnique({
      where: { id: runId },
      include: { snapshots: { orderBy: { revision: "desc" }, take: 1 } },
    });
    if (existing?.status === "completed" && existing.snapshots[0]) return existing.snapshots[0];
    if (!existing || existing.status !== "active" || existing.leaseToken !== leaseToken || !existing.leaseUntil || existing.leaseUntil <= new Date()) {
      throw new Error("Recommendation run lease is stale");
    }

    return this.database.$transaction(async (tx) => {
      const [controlEpoch] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "safety_control_epoch" WHERE "id" = 'global' FOR SHARE
      `;
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${existing.userId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "recommendation_runs" WHERE "id" = ${runId}::uuid FOR UPDATE`;
      const run = await tx.recommendationRun.findUniqueOrThrow({
        where: { id: runId },
        include: {
          user: { include: { consents: true } },
          inputSnapshot: true,
          ruleBundle: true,
          factInputs: { include: { factRevision: true }, orderBy: { factRevisionId: "asc" } },
          labInputs: { orderBy: { labObservationId: "asc" } },
        },
      });
      this.assertLease(run, leaseToken);
      const request = await tx.domainOutbox.findFirst({
        where: { aggregateId: run.id, eventType: "recommendation.run.requested" },
        include: { consentRequirements: true },
      });
      const reconciliation = await tx.privacyReconciliation.findUnique({ where: { id: "global" } });
      const latestProfile = await tx.profileSnapshot.findFirst({
        where: { userId: run.userId, consentEpoch: run.consentEpoch },
        orderBy: { version: "desc" },
      });
      const consent = [...run.user.consents]
        .filter((item) => item.consentType === "health_processing")
        .sort((left, right) => right.epoch - left.epoch)[0];
      const requirement = request?.consentRequirements.find((item) => item.purpose === "health_processing");
      const controlWhere = (controlType: string, controlKey: string, scopeType: string, scopeId: string) => ({
        controlType,
        controlKey,
        scopeType,
        scopeId,
      });
      const [dailyFeature, globalStop, userStop, ruleStop, llmStop] = await Promise.all([
        tx.safetyControlRevision.findFirst({
          where: controlWhere("feature_flag", "feature.daily_recommendations", "global", "*"),
          orderBy: { version: "desc" }, select: { active: true },
        }),
        tx.safetyControlRevision.findFirst({
          where: controlWhere("kill_switch", "global.proactive_messages", "global", "*"),
          orderBy: { version: "desc" }, select: { active: true },
        }),
        tx.safetyControlRevision.findFirst({
          where: controlWhere("kill_switch", "user.recommendations", "user", run.userId),
          orderBy: { version: "desc" }, select: { active: true },
        }),
        tx.safetyControlRevision.findFirst({
          where: controlWhere("kill_switch", "rule.bundle", "rule_bundle", run.ruleBundleId),
          orderBy: { version: "desc" }, select: { active: true },
        }),
        tx.safetyControlRevision.findFirst({
          where: controlWhere("kill_switch", "llm.generation", "global", "*"),
          orderBy: { version: "desc" }, select: { active: true },
        }),
      ]);
      const suppressionReason = !controlEpoch ? "control_epoch_missing"
        : !request ? "missing_request"
        : run.user.status !== "active" || run.user.deletedAt ? "user_inactive"
          : reconciliation?.status !== "ready" ? "privacy_not_ready"
            : !consent?.granted || consent.epoch !== run.consentEpoch || requirement?.grantEpoch !== run.consentEpoch
              ? "consent_invalid"
                : latestProfile?.id !== run.inputSnapshotId ? "profile_superseded"
                  : run.ruleBundle.status !== "active" || !run.ruleBundle.bundleDigest ? "rule_bundle_invalid"
                    : !dailyFeature?.active ? "feature_daily_recommendations_disabled"
                      : globalStop?.active ? "kill_switch_global"
                        : userStop?.active ? "kill_switch_user"
                          : ruleStop?.active ? "kill_switch_rule_bundle"
                            : null;
      if (suppressionReason) {
        await this.suppress(tx, run.id, leaseToken, request?.id);
        await this.telemetry.record({
          eventName: "recommendation.suppressed",
          severity: "warn",
          correlationId: run.correlationId,
          attributes: {
            component: "recommendation-worker",
            status: "suppressed",
            reason_code: suppressionReason,
          },
        });
        return null;
      }
      if (!request) throw new Error("Recommendation request disappeared after boundary validation");
      const [inputBinding] = await tx.$queryRaw<Array<{ valid: boolean }>>`
        SELECT "input_hash" = encode(digest("input_manifest_json"::text, 'sha256'), 'hex') AS "valid"
        FROM "recommendation_runs" WHERE "id" = ${run.id}::uuid
      `;
      const inputManifest = run.inputManifestJson;
      if (!inputBinding?.valid || !inputManifest || typeof inputManifest !== "object" || Array.isArray(inputManifest)) {
        throw new Error("Stored recommendation input manifest hash is invalid");
      }
      const ruleInput = (inputManifest as Prisma.JsonObject).rule_input;
      if (!isRuleInput(ruleInput)) throw new Error("Stored recommendation rule input is invalid");
      const result = evaluateRule(ruleInput);
      const bundleContent = run.ruleBundle.contentJson;
      if (!bundleContent || typeof bundleContent !== "object" || Array.isArray(bundleContent)) {
        throw new Error("Active rule bundle content is unavailable");
      }
      const bundleIdentity = bundleContent as Prisma.JsonObject;
      const bundleReviewPercent = Number(bundleIdentity.beta_normal_review_percent);
      if (
        bundleIdentity.rules_engine !== "deterministic-rules-v1" ||
        bundleIdentity.rules_engine_digest !== RULES_ENGINE_ARTIFACT_DIGEST ||
        !Number.isInteger(bundleReviewPercent) || bundleReviewPercent < 20 || bundleReviewPercent > 100 ||
        this.policy.normalSamplePercent !== bundleReviewPercent
      ) {
        throw new Error("Active rule bundle does not match the running rules artifact and review policy");
      }
      const ruleKey = result.riskArea && result.actionCode ? `${result.riskArea}:${result.actionCode}` : `${result.outcome}:NONE`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`rule:${ruleKey}`}, 0))`;
      const [qualification] = result.outcome === "action" ? await tx.$queryRaw<Array<{
        approval_count: bigint;
        incident_count: bigint;
      }>>`
        SELECT
          (
            SELECT count(DISTINCT reviewed_run."id")::bigint
            FROM "recommendation_review_events" e
            JOIN "recommendation_snapshots" s ON s."id" = e."snapshot_id"
            JOIN "recommendation_runs" reviewed_run ON reviewed_run."id" = s."run_id"
            JOIN "recommendation_review_tasks" task ON task."snapshot_id" = e."from_snapshot_id"
            JOIN "recommendation_publications" publication ON publication."snapshot_id" = s."id"
            WHERE e."event_type" = 'approved'
              AND s."review_status" = 'published'
              AND reviewed_run."rule_bundle_id" = ${run.ruleBundle.id}::uuid
              AND s."provenance_json"->>'rule_key' = ${ruleKey}
              AND task."status" = 'completed'
              AND e."created_at" <= task."sla_at"
          ) AS "approval_count",
          (
            SELECT count(*)::bigint FROM "safety_incidents"
            WHERE "source" = ${`rule:${ruleKey}`}
          ) AS "incident_count"
      ` : [];
      const localDate = run.localDate.toISOString().slice(0, 10);
      const bucket = result.safetyClass === "normal" && this.policy.releaseStage === "beta"
        ? samplingBucket(run.userId, localDate, result.riskArea)
        : null;
      const route = result.outcome === "blocked" ? "blocked"
        : result.outcome === "doctor" ? "fixed_fallback"
          : this.policy.releaseStage === "beta" && result.outcome === "action" && result.safetyClass === "normal"
            && run.ruleBundle.autoPublishEligible
            && (qualification?.approval_count ?? 0n) >= 100n
            && (qualification?.incident_count ?? 1n) === 0n
            && bucket !== null && bucket >= bundleReviewPercent
            ? "auto_publish"
            : "review_required";
      const renderedPayload = result.outcome === "doctor"
        ? { template: "doctor_fixed_boundary_v1", action_code: null, safety_class: "doctor" }
        : result.outcome === "action"
          ? { template: "daily_action_v1", action_code: result.actionCode, safety_class: result.safetyClass, risk_area: result.riskArea }
          : { template: "no_action_v1", action_code: null, safety_class: result.safetyClass, reason_code: result.reasonCode };
      const generatedAt = new Date().toISOString();
      const provenance = {
        profile_snapshot_id: run.inputSnapshot.id,
        profile_snapshot_hash: run.inputSnapshot.snapshotHash,
        daily_fact_revision_ids: run.factInputs.map((item) => item.factRevisionId),
        daily_fact_input_hashes: run.factInputs.map((item) => item.inputHash),
        lab_observation_ids: run.labInputs.map((item) => item.labObservationId),
        lab_observation_hashes: run.labInputs.map((item) => item.observationHash),
        rule_bundle_id: run.ruleBundle.id,
        rule_bundle_digest: run.ruleBundle.bundleDigest,
        rules_engine: bundleIdentity.rules_engine,
        rules_engine_digest: bundleIdentity.rules_engine_digest,
        safety_bundle: bundleIdentity.safety_bundle_digest,
        localization_bundle: bundleIdentity.localization_bundle_digest,
        template_bundle: bundleIdentity.template_bundle_digest,
        prompt_version: null,
        provider_id: null,
        model_id: null,
        rendered_payload_hash: sha256(renderedPayload),
        generated_at: generatedAt,
        rule_result: result,
        rule_key: ruleKey,
        llm_kill_switch_active: !this.policy.llmEnabled || Boolean(llmStop?.active),
      };
      const policyDigest = sha256({
        release_stage: this.policy.releaseStage,
        normal_sample_percent: this.policy.normalSamplePercent,
        llm_enabled: this.policy.llmEnabled && !llmStop?.active,
        rules_engine: bundleIdentity.rules_engine,
        rules_engine_digest: bundleIdentity.rules_engine_digest,
        safety_bundle: bundleIdentity.safety_bundle_digest,
        localization_bundle: bundleIdentity.localization_bundle_digest,
        template_bundle: bundleIdentity.template_bundle_digest,
      });
      const reviewStatus = route === "blocked" ? RecommendationReviewStatus.blocked
        : route === "review_required" ? RecommendationReviewStatus.review_required
          : RecommendationReviewStatus.published;
      const snapshot = await tx.recommendationSnapshot.create({
        data: {
          runId: run.id,
          revision: 1,
          riskArea: result.riskArea,
          safetyClass: result.safetyClass,
          actionCode: result.actionCode,
          renderedPayloadJson: renderedPayload,
          canonicalRuleInputJson: ruleInput as unknown as Prisma.InputJsonObject,
          provenanceJson: provenance as unknown as Prisma.InputJsonObject,
          reviewStatus,
          releaseStage: this.policy.releaseStage,
          reviewRoute: route,
          policyDigest,
          samplingBucket: bucket,
          reviewSamplePercent: bundleReviewPercent,
        },
      });

      if (route === "review_required") {
        await tx.recommendationReviewEvent.create({ data: { snapshotId: snapshot.id, eventType: "submitted" } });
        await tx.recommendationReviewTask.create({
          data: {
            snapshotId: snapshot.id,
            priority: result.safetyClass === "caution" ? "high" : "normal",
            slaAt: new Date(Date.now() + this.policy.reviewSlaSeconds * 1_000),
            reasonCode: "REVIEW_POLICY",
          },
        });
      } else if (route === "blocked") {
        await tx.recommendationReviewEvent.create({ data: { snapshotId: snapshot.id, eventType: "blocked", reasonCode: result.reasonCode } });
      } else {
        if (route === "fixed_fallback") {
          await tx.recommendationReviewEvent.create({ data: { snapshotId: snapshot.id, eventType: "submitted", reasonCode: "DOCTOR_FOLLOW_UP" } });
          await tx.recommendationReviewTask.create({
            data: {
              snapshotId: snapshot.id,
              priority: "high",
              slaAt: new Date(Date.now() + this.policy.reviewSlaSeconds * 1_000),
              reasonCode: "DOCTOR_FOLLOW_UP",
            },
          });
        } else {
          await tx.recommendationReviewEvent.create({ data: { snapshotId: snapshot.id, eventType: RecommendationReviewEventType.auto_published } });
        }
        await this.createManifest(tx, snapshot, run.userId, run.localDate, run.consentEpoch);
      }
      const completed = await tx.recommendationRun.updateMany({
        where: { id: run.id, status: "active", leaseToken, leaseUntil: { gt: new Date() } },
        data: { status: "completed", leaseToken: null, leaseUntil: null },
      });
      if (completed.count !== 1) throw new Error("Recommendation run lease expired before commit");
      await tx.domainOutbox.update({ where: { id: request.id }, data: { status: "sent", leaseToken: null, leaseUntil: null } });
      await tx.consumerInbox.create({
        data: { consumer: "recommendation-worker-v1", messageId: request.id, resultHash: snapshot.snapshotHash ?? "pending-db-hash" },
      });
      await this.telemetry.record({
        eventName: "recommendation.completed",
        severity: "info",
        correlationId: run.correlationId,
        attributes: {
          component: "recommendation-worker",
          status: "complete",
          outcome: route,
        },
      });
      return snapshot;
    });
  }

  private assertLease(run: { status: string; leaseToken: string | null; leaseUntil: Date | null }, leaseToken: string) {
    if (run.status !== "active" || run.leaseToken !== leaseToken || !run.leaseUntil || run.leaseUntil <= new Date()) {
      throw new Error("Recommendation run lease is stale");
    }
  }

  private async suppress(tx: Prisma.TransactionClient, runId: string, leaseToken: string, requestId?: string) {
    const suppressed = await tx.recommendationRun.updateMany({
      where: { id: runId, status: "active", leaseToken },
      data: { status: "suppressed", leaseToken: null, leaseUntil: null },
    });
    if (suppressed.count !== 1) throw new Error("Recommendation suppression lease is stale");
    if (requestId) await tx.domainOutbox.update({ where: { id: requestId }, data: { status: "suppressed" } });
  }

  private async createManifest(
    tx: Prisma.TransactionClient,
    snapshot: { id: string; actionCode: string | null; snapshotHash: string | null },
    userId: string,
    localDate: Date,
    consentEpoch: number,
  ) {
    const action = snapshot.actionCode ? await tx.actionAssignment.create({
      data: {
        userId,
        recommendationSnapshotId: snapshot.id,
        localDate,
        difficulty: getAction(snapshot.actionCode as Parameters<typeof getAction>[0]).difficulty,
        status: "active",
      },
    }) : null;
    const domain = await tx.domainOutbox.create({
      data: {
        eventType: "recommendation.published",
        aggregateId: snapshot.id,
        userId,
        idempotencyKey: `recommendation.published:${snapshot.id}`,
        payload: { recommendation_snapshot_id: snapshot.id },
        consentRequirements: { create: { purpose: "health_processing", grantEpoch: consentEpoch } },
      },
    });
    const channel = await tx.channelOutbox.create({
      data: {
        userId,
        channel: "in_app",
        template: "recommendation_snapshot",
        payload: { recommendation_snapshot_id: snapshot.id },
        idempotencyKey: `in_app:recommendation:${snapshot.id}`,
        consentRequirements: { create: { purpose: "health_processing", grantEpoch: consentEpoch } },
      },
    });
    const audit = await tx.auditLog.create({
      data: {
        action: "recommendation.auto_published",
        resourceType: "recommendation_snapshot",
        resourceId: snapshot.id,
        afterHash: snapshot.snapshotHash,
      },
    });
    await tx.recommendationPublication.create({
      data: {
        snapshotId: snapshot.id,
        actionAssignmentId: action?.id ?? null,
        domainOutboxId: domain.id,
        auditLogId: audit.id,
        channels: { create: { channelOutboxId: channel.id } },
      },
    });
  }
}
