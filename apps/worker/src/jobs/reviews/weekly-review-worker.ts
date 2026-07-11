import type { Prisma, PrismaClient } from "@prisma/client";
import { buildWeeklyReviewSharePayload } from "@healthos/contracts";
import {
  deriveWeeklyReview,
  type ReviewActionCode,
  type ReviewSignalCode,
  type ReviewSignalFreshness,
  type ReviewSignalState,
  type ReviewSignalTrend,
} from "./weekly-review-projector";

export class PermanentWeeklyReviewError extends Error {
  override readonly name = "PermanentWeeklyReviewError";
}

function permanent(message: string): never {
  throw new PermanentWeeklyReviewError(message);
}

function ruleSource(value: Prisma.JsonValue): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return typeof value.rule_key === "string" ? `rule:${value.rule_key}` : null;
}

function date(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function feedbackOutcome(value: Prisma.JsonValue) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const outcome = value.outcome;
  return ["completed", "skipped", "replaced", "no_safe_alternative"].includes(String(outcome))
    ? outcome as "completed" | "skipped" | "replaced" | "no_safe_alternative"
    : null;
}

function actionCode(value: string | null): ReviewActionCode | null {
  return ["SLEEP_WIND_DOWN", "SLEEP_WIND_DOWN_LIGHT", "POST_MEAL_WALK", "SUGARY_DRINK_SWAP"].includes(value ?? "")
    ? value as ReviewActionCode
    : null;
}

export interface WeeklyReviewWorkerConfig {
  shareTtlSeconds: number;
  now?: () => Date;
}

export class WeeklyReviewWorker {
  constructor(private readonly database: PrismaClient, private readonly config: WeeklyReviewWorkerConfig) {}

  async project(input: { userId: string; weekStart: string; cutoffAt: Date; consentEpoch: number }) {
    const weekStart = new Date(`${input.weekStart}T00:00:00.000Z`);
    const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);
    if (!Number.isFinite(weekStart.getTime()) || input.cutoffAt < weekEnd) {
      permanent("Weekly review generation window is invalid");
    }
    return this.database.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`weekly-review:${input.userId}:${input.weekStart}`}, 0))
      `;
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${input.userId}::uuid FOR UPDATE`;
      const user = await tx.user.findUnique({
        where: { id: input.userId }, include: { consents: true },
      });
      const consent = [...(user?.consents ?? [])]
        .filter((item) => item.consentType === "health_processing")
        .sort((left, right) => right.epoch - left.epoch)[0];
      const privacy = await tx.privacyReconciliation.findUnique({ where: { id: "global" } });
      if (privacy?.status !== "ready") throw new Error("Weekly review is temporarily unavailable during privacy reconciliation");
      if (!user || user.status !== "active" || user.deletedAt || !consent?.granted ||
        consent.epoch !== input.consentEpoch) {
        permanent("Weekly review authorization is no longer current");
      }
      const existing = await tx.weeklyReviewSnapshot.findFirst({
        where: { userId: input.userId, weekStart, cutoffAt: input.cutoffAt, consentEpoch: input.consentEpoch },
        include: { shares: true },
      });
      if (existing) return existing;

      const signals = await tx.signalSnapshot.findMany({
        where: {
          userId: input.userId,
          localDate: { gte: weekStart, lt: weekEnd },
          createdAt: { lte: input.cutoffAt },
          recommendationSnapshot: {
            is: {
              reviewStatus: "published",
              run: { consentEpoch: input.consentEpoch, ruleBundle: { status: { in: ["active", "superseded"] } } },
            },
          },
        },
        include: { recommendationSnapshot: true },
        orderBy: [{ localDate: "asc" }, { signalCode: "asc" }, { revision: "desc" }],
      });
      const actions = await tx.actionAssignment.findMany({
        where: {
          userId: input.userId,
          localDate: { gte: weekStart, lt: weekEnd },
          createdAt: { lte: input.cutoffAt },
          recommendationSnapshot: {
            reviewStatus: "published",
            run: { consentEpoch: input.consentEpoch, ruleBundle: { status: { in: ["active", "superseded"] } } },
          },
        },
        include: {
          recommendationSnapshot: true,
          feedback: { where: { occurredAt: { lte: input.cutoffAt } }, orderBy: { occurredAt: "asc" } },
        },
        orderBy: [{ localDate: "asc" }, { createdAt: "asc" }],
      });
      const sources = [...new Set([
        ...signals.map((item) => ruleSource(item.recommendationSnapshot?.provenanceJson ?? null)),
        ...actions.map((item) => ruleSource(item.recommendationSnapshot.provenanceJson)),
      ].filter((item): item is string => item !== null))];
      const unsafe = sources.length === 0 ? new Set<string>() : new Set((await tx.safetyIncident.findMany({
        where: { source: { in: sources } }, select: { source: true },
      })).map((item) => item.source));
      const safeSignals = signals.filter((item) => {
        const source = ruleSource(item.recommendationSnapshot?.provenanceJson ?? null);
        return source !== null && !unsafe.has(source);
      });
      const safeActions = actions.filter((item) => {
        const source = ruleSource(item.recommendationSnapshot.provenanceJson);
        return source !== null && !unsafe.has(source) && actionCode(item.actionCode) !== null;
      });
      const latestSignals = [...new Map([...safeSignals].reverse().map((item) => [
        `${date(item.localDate)}:${item.signalCode}`, item,
      ])).values()].sort((left, right) =>
        left.localDate.getTime() - right.localDate.getTime() || left.signalCode.localeCompare(right.signalCode));
      const feedback = safeActions.flatMap((item) => item.feedback)
        .map((item) => ({ item, outcome: feedbackOutcome(item.resultJson) }))
        .filter((entry): entry is { item: typeof entry.item; outcome: NonNullable<typeof entry.outcome> } =>
          entry.outcome !== null);
      const derived = deriveWeeklyReview({
        weekStart: input.weekStart,
        cutoffAt: input.cutoffAt,
        signals: latestSignals.map((item) => ({
          id: item.id,
          localDate: date(item.localDate),
          signalCode: item.signalCode as ReviewSignalCode,
          state: item.state as ReviewSignalState,
          trend: item.trend as ReviewSignalTrend,
          freshness: item.freshness as ReviewSignalFreshness,
          createdAt: item.createdAt,
        })),
        actions: safeActions.map((item) => ({
          id: item.id,
          localDate: date(item.localDate),
          actionCode: actionCode(item.actionCode)!,
          status: item.status,
          createdAt: item.createdAt,
        })),
        feedback: feedback.map(({ item, outcome }) => ({
          id: item.id, actionAssignmentId: item.actionAssignmentId, type: item.type,
          reasonCode: item.reasonCode, outcome, occurredAt: item.occurredAt,
        })),
      });
      const provenance = {
        week_start: input.weekStart,
        cutoff_at: input.cutoffAt.toISOString(),
        consent_epoch: input.consentEpoch,
        signal_snapshot_ids: latestSignals.map((item) => item.id).sort(),
        action_assignment_ids: safeActions.map((item) => item.id).sort(),
        feedback_event_ids: feedback.map(({ item }) => item.id).sort(),
      };
      const prior = await tx.weeklyReviewSnapshot.aggregate({
        where: { userId: input.userId, weekStart }, _max: { revision: true },
      });
      const snapshot = await tx.weeklyReviewSnapshot.create({ data: {
        userId: input.userId,
        weekStart,
        cutoffAt: input.cutoffAt,
        consentEpoch: input.consentEpoch,
        coverage: derived.coverage,
        conclusion: derived.conclusionKey,
        evidenceJson: derived.evidence as unknown as Prisma.InputJsonValue,
        frictionJson: derived.friction as unknown as Prisma.InputJsonObject,
        nextActionsJson: derived.nextActions as unknown as Prisma.InputJsonValue,
        provenanceJson: provenance,
        sourceHash: "0".repeat(64),
        snapshotHash: "0".repeat(64),
        revision: (prior._max.revision ?? 0) + 1,
      } });
      const stored = {
        id: snapshot.id,
        weekStart: snapshot.weekStart,
        cutoffAt: snapshot.cutoffAt!,
        revision: snapshot.revision,
        coverage: Number(snapshot.coverage),
        conclusion: derived.conclusionKey,
        evidence: derived.evidence,
        friction: derived.friction,
        nextActions: derived.nextActions,
        createdAt: snapshot.createdAt,
      };
      const expiresAt = new Date((this.config.now?.() ?? new Date()).getTime() + this.config.shareTtlSeconds * 1_000);
      for (const variant of ["redacted", "private"] as const) {
        await tx.weeklyReviewShare.create({ data: {
          weeklyReviewSnapshotId: snapshot.id,
          userId: input.userId,
          variant,
          payloadJson: buildWeeklyReviewSharePayload(stored, variant) as unknown as Prisma.InputJsonObject,
          payloadHash: "0".repeat(64),
          expiresAt,
        } });
      }
      return tx.weeklyReviewSnapshot.findUniqueOrThrow({
        where: { id: snapshot.id }, include: { shares: true },
      });
    });
  }
}
