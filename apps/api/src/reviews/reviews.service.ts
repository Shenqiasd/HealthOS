import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type {
  ReviewEvidenceRow,
  ReviewConclusionKey,
  ReviewFrictionSummary,
  ReviewGenerationRequest,
  ReviewGenerationResponse,
  ReviewNextAction,
  ReviewShareResponse,
  ReviewShareVariant,
  WeeklyReviewViewModel,
} from "@healthos/contracts";
import type { Prisma } from "@prisma/client";

import { DatabaseService } from "../database/prisma.service";
import { buildReviewView } from "./review-view";

function object(value: Prisma.JsonValue): Prisma.JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function array<T>(value: Prisma.JsonValue): T[] {
  return Array.isArray(value) ? value as unknown as T[] : [];
}

function monday(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.getUTCDay() === 1 && parsed.toISOString().slice(0, 10) === value;
}

function requestStatus(status: string): ReviewGenerationResponse["status"] {
  if (["pending", "leased", "sent", "failed", "suppressed"].includes(status)) {
    return status as ReviewGenerationResponse["status"];
  }
  throw new ConflictException("Review generation request has an invalid state");
}

@Injectable()
export class ReviewsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async request(userId: string, input: ReviewGenerationRequest, now = new Date()): Promise<ReviewGenerationResponse> {
    const weekStart = new Date(`${input.week_start}T00:00:00.000Z`);
    const cutoffAt = new Date(input.cutoff_at);
    const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);
    if (!monday(input.week_start) || !Number.isFinite(cutoffAt.getTime()) || cutoffAt < weekEnd || cutoffAt > now) {
      throw new ConflictException("Review generation window is invalid");
    }
    return this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: userId } });
      const consent = await tx.consentRecord.findFirst({
        where: { userId, consentType: "health_processing" }, orderBy: { epoch: "desc" },
      });
      const privacy = await tx.privacyReconciliation.findUnique({ where: { id: "global" } });
      if (!user || user.status !== "active" || user.deletedAt || !consent?.granted || privacy?.status !== "ready") {
        throw new ForbiddenException("Current health-processing authorization is required");
      }
      const idempotencyKey = `weekly-review.generate:${userId}:${input.idempotency_key}`;
      const payload = {
        user_id: userId,
        week_start: input.week_start,
        cutoff_at: cutoffAt.toISOString(),
        consent_epoch: consent.epoch,
      };
      const existing = await tx.domainOutbox.findUnique({ where: { idempotencyKey } });
      if (existing) {
        const prior = object(existing.payload);
        if (prior?.user_id !== payload.user_id || prior.week_start !== payload.week_start ||
          prior.cutoff_at !== payload.cutoff_at || prior.consent_epoch !== payload.consent_epoch) {
          throw new ConflictException("Review generation idempotency key was reused");
        }
        return { request_id: existing.id, status: requestStatus(existing.status) };
      }
      const request = await tx.domainOutbox.create({ data: {
        eventType: "weekly_review.generate_requested",
        aggregateId: userId,
        userId,
        idempotencyKey,
        payload,
        consentRequirements: { create: { purpose: "health_processing", grantEpoch: consent.epoch } },
      } });
      return { request_id: request.id, status: requestStatus(request.status) };
    });
  }

  async current(userId: string, weekStart?: string): Promise<WeeklyReviewViewModel> {
    const { consentEpoch } = await this.authorize(userId);
    if (weekStart && !monday(weekStart)) throw new ConflictException("Review week must start on Monday");
    const snapshot = await this.database.weeklyReviewSnapshot.findFirst({
      where: {
        userId,
        consentEpoch,
        cutoffAt: { not: null },
        ...(weekStart ? { weekStart: new Date(`${weekStart}T00:00:00.000Z`) } : {}),
      },
      orderBy: [{ weekStart: "desc" }, { revision: "desc" }],
    });
    if (!snapshot?.cutoffAt || !snapshot.frictionJson) throw new NotFoundException("Weekly review is not available");
    await this.assertSourcesRemainSafe(snapshot.provenanceJson);
    return buildReviewView({
      id: snapshot.id,
      weekStart: snapshot.weekStart,
      cutoffAt: snapshot.cutoffAt,
      revision: snapshot.revision,
      coverage: Number(snapshot.coverage),
      conclusion: snapshot.conclusion as ReviewConclusionKey,
      evidence: array<ReviewEvidenceRow>(snapshot.evidenceJson),
      friction: object(snapshot.frictionJson) as unknown as ReviewFrictionSummary,
      nextActions: array<ReviewNextAction>(snapshot.nextActionsJson),
      createdAt: snapshot.createdAt,
    });
  }

  async share(userId: string, reviewId: string, variant: ReviewShareVariant, now = new Date()): Promise<ReviewShareResponse> {
    return this.database.$transaction(async (tx) => {
      const [controlEpoch] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "safety_control_epoch" WHERE "id" = 'global' FOR SHARE
      `;
      if (!controlEpoch) throw new ServiceUnavailableException("Safety controls are unavailable");
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId}::uuid FOR SHARE`;
      const { consentEpoch } = await this.authorize(userId, tx);
      const [shareFeature, shareStopped] = await Promise.all([
        tx.safetyControlRevision.findFirst({
          where: {
            controlType: "feature_flag",
            controlKey: "feature.weekly_review_share",
            scopeType: "global",
            scopeId: "*",
          },
          orderBy: { version: "desc" },
          select: { active: true },
        }),
        tx.safetyControlRevision.findFirst({
          where: {
            controlType: "kill_switch",
            controlKey: "review.share",
            scopeType: "global",
            scopeId: "*",
          },
          orderBy: { version: "desc" },
          select: { active: true },
        }),
      ]);
      if (!shareFeature?.active) throw new GoneException("Weekly review sharing is not enabled");
      if (shareStopped?.active) throw new GoneException("Weekly review sharing is temporarily unavailable");
      const share = await tx.weeklyReviewShare.findFirst({
        where: {
          userId,
          variant,
          weeklyReviewSnapshotId: reviewId,
          review: { consentEpoch },
        },
        include: { review: true },
      });
      if (!share) throw new NotFoundException("Weekly review share is not available");
      if (share.expiresAt <= now) throw new GoneException("Weekly review share has expired");
      await this.assertSourcesRemainSafe(share.review.provenanceJson, tx);
      return {
        id: share.id,
        expires_at: share.expiresAt.toISOString(),
        payload: share.payloadJson as unknown as ReviewShareResponse["payload"],
      };
    }, { isolationLevel: "ReadCommitted" });
  }

  private async authorize(
    userId: string,
    database: Prisma.TransactionClient = this.database,
  ): Promise<{ consentEpoch: number }> {
    const user = await database.user.findUnique({ where: { id: userId } });
    const consent = await database.consentRecord.findFirst({
      where: { userId, consentType: "health_processing" }, orderBy: { epoch: "desc" },
    });
    const privacy = await database.privacyReconciliation.findUnique({ where: { id: "global" } });
    if (!user || user.status !== "active" || user.deletedAt || !consent?.granted || privacy?.status !== "ready") {
      throw new ForbiddenException("Current health-processing authorization is required");
    }
    return { consentEpoch: consent.epoch };
  }

  private async assertSourcesRemainSafe(
    provenanceValue: Prisma.JsonValue,
    database: Prisma.TransactionClient = this.database,
  ): Promise<void> {
    const provenance = object(provenanceValue);
    const signalIds = array<string>(provenance?.signal_snapshot_ids ?? []);
    const actionIds = array<string>(provenance?.action_assignment_ids ?? []);
    const [signals, actions] = await Promise.all([
      database.signalSnapshot.findMany({
        where: { id: { in: signalIds } },
        include: { recommendationSnapshot: { include: { run: { include: { ruleBundle: true } } } } },
      }),
      database.actionAssignment.findMany({
        where: { id: { in: actionIds } },
        include: { recommendationSnapshot: { include: { run: { include: { ruleBundle: true } } } } },
      }),
    ]);
    if (signals.length !== signalIds.length || actions.length !== actionIds.length) {
      throw new NotFoundException("Weekly review source evidence is unavailable");
    }
    const snapshots = [
      ...signals.map((item) => item.recommendationSnapshot).filter((item) => item !== null),
      ...actions.map((item) => item.recommendationSnapshot),
    ];
    if (snapshots.some((item) => item.reviewStatus !== "published" || item.run.ruleBundle.status === "rolled_back")) {
      throw new NotFoundException("Weekly review source evidence was withdrawn");
    }
    const sources = [...new Set(snapshots.map((item) => {
      const value = object(item.provenanceJson);
      return typeof value?.rule_key === "string" ? `rule:${value.rule_key}` : null;
    }).filter((item): item is string => item !== null))];
    if (sources.length > 0 && await database.safetyIncident.count({ where: { source: { in: sources } } }) > 0) {
      throw new NotFoundException("Weekly review source evidence was withdrawn");
    }
  }
}
