import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { getAction } from "@healthos/rules";
import { RecommendationReviewEventType, RecommendationReviewStatus, type Prisma } from "@prisma/client";

import { canonicalSha256 } from "../profile/canonical-json";
import { DatabaseService } from "./prisma.service";

export interface PublishReviewedRecommendationInput {
  draftSnapshotId: string;
  actorId: string;
  reasonCode: string;
  renderedPayload?: Prisma.InputJsonObject;
}

function auditActor(actorId: string): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actorId)
    ? actorId
    : null;
}

function validateReviewedPayload(
  draft: { actionCode: string | null; safetyClass: string; riskArea: string | null },
  payload: Prisma.InputJsonObject,
): void {
  const keys = Object.keys(payload);
  const allowed = new Set(["template", "action_code", "safety_class", "risk_area", "copy_key"]);
  if (
    !draft.actionCode || !draft.riskArea ||
    keys.some((key) => !allowed.has(key)) ||
    payload.template !== "daily_action_v1" ||
    payload.action_code !== draft.actionCode ||
    payload.safety_class !== draft.safetyClass ||
    payload.risk_area !== draft.riskArea ||
    typeof payload.copy_key !== "string" || !/^review\.[a-z0-9_.-]+$/.test(payload.copy_key)
  ) {
    throw new ConflictException("Reviewed payload exceeds the deterministic output contract");
  }
}

@Injectable()
export class PublicationRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async publishReviewed(input: PublishReviewedRecommendationInput) {
    if (!input.actorId.trim() || !input.reasonCode.trim()) {
      throw new ConflictException("Review publication requires actor and reason");
    }
    return this.database.$transaction(async (tx) => {
      const draft = await tx.recommendationSnapshot.findUnique({
        where: { id: input.draftSnapshotId },
        include: { run: { include: { user: { include: { consents: true } }, ruleBundle: true } } },
      });
      if (!draft || draft.reviewStatus !== "review_required" || draft.reviewRoute !== "review_required") {
        throw new ConflictException("Recommendation is not awaiting review");
      }
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${draft.run.userId}::uuid FOR UPDATE`;
      const task = await tx.recommendationReviewTask.findFirst({
        where: { snapshotId: draft.id, status: { in: ["pending", "active"] } },
      });
      if (!task || task.slaAt <= new Date()) throw new ConflictException("Recommendation review SLA has expired");
      const latestConsent = [...draft.run.user.consents]
        .filter((consent) => consent.consentType === "health_processing")
        .sort((left, right) => right.epoch - left.epoch)[0];
      const reconciliation = await tx.privacyReconciliation.findUnique({ where: { id: "global" } });
      const latestProfile = await tx.profileSnapshot.findFirst({
        where: { userId: draft.run.userId, consentEpoch: draft.run.consentEpoch },
        orderBy: { version: "desc" },
      });
      if (
        draft.run.user.status !== "active" ||
        draft.run.user.deletedAt ||
        !latestConsent?.granted ||
        latestConsent.epoch !== draft.run.consentEpoch ||
        reconciliation?.status !== "ready" ||
        draft.run.ruleBundle.status !== "active" ||
        latestProfile?.id !== draft.run.inputSnapshotId
      ) {
        throw new ConflictException("Recommendation authorization changed before review");
      }

      if (input.renderedPayload) validateReviewedPayload(draft, input.renderedPayload);
      const renderedPayload = input.renderedPayload ?? draft.renderedPayloadJson as Prisma.InputJsonObject;
      const provenance = {
        ...(draft.provenanceJson as Prisma.JsonObject),
        rendered_payload_hash: canonicalSha256(renderedPayload),
        review: {
          actor_id: input.actorId.trim(),
          reason_code: input.reasonCode.trim(),
          source_snapshot_id: draft.id,
        },
      } as Prisma.InputJsonObject;
      const published = await tx.recommendationSnapshot.create({
        data: {
          runId: draft.runId,
          revision: draft.revision + 1,
          supersedesId: draft.id,
          riskArea: draft.riskArea,
          safetyClass: draft.safetyClass,
          actionCode: draft.actionCode,
          renderedPayloadJson: renderedPayload,
          canonicalRuleInputJson: draft.canonicalRuleInputJson as Prisma.InputJsonValue,
          provenanceJson: provenance,
          reviewStatus: RecommendationReviewStatus.published,
          releaseStage: draft.releaseStage,
          reviewRoute: draft.reviewRoute,
          policyDigest: draft.policyDigest,
          samplingBucket: draft.samplingBucket,
          reviewSamplePercent: draft.reviewSamplePercent,
        },
      });
      if (input.renderedPayload) {
        await tx.recommendationReviewEvent.create({
          data: {
            snapshotId: published.id,
            eventType: RecommendationReviewEventType.edited,
            actorId: input.actorId.trim(),
            reasonCode: input.reasonCode.trim(),
            fromSnapshotId: draft.id,
            toSnapshotId: published.id,
            beforeHash: draft.snapshotHash,
            afterHash: published.snapshotHash,
          },
        });
      }
      await tx.recommendationReviewEvent.create({
        data: {
          snapshotId: published.id,
          eventType: RecommendationReviewEventType.approved,
          actorId: input.actorId.trim(),
          reasonCode: input.reasonCode.trim(),
          fromSnapshotId: draft.id,
          toSnapshotId: published.id,
          beforeHash: draft.snapshotHash,
          afterHash: published.snapshotHash,
        },
      });
      await tx.recommendationReviewTask.update({ where: { id: task.id }, data: { status: "completed" } });
      const manifest = await this.createPublicationManifest(tx, published, draft.run.userId, draft.run.localDate, draft.run.consentEpoch, input.actorId);
      return { snapshot: published, manifest };
    });
  }

  private async createPublicationManifest(
    tx: Prisma.TransactionClient,
    snapshot: { id: string; actionCode: string | null; snapshotHash: string | null },
    userId: string,
    localDate: Date,
    consentEpoch: number,
    actorId: string,
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
        actorId: auditActor(actorId),
        action: "recommendation.published",
        resourceType: "recommendation_snapshot",
        resourceId: snapshot.id,
        afterHash: snapshot.snapshotHash,
      },
    });
    return tx.recommendationPublication.create({
      data: {
        snapshotId: snapshot.id,
        actionAssignmentId: action?.id ?? null,
        domainOutboxId: domain.id,
        auditLogId: audit.id,
        channels: { create: { channelOutboxId: channel.id } },
      },
      include: { channels: true },
    });
  }
}
