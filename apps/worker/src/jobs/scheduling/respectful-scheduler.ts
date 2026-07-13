import { createHash } from "node:crypto";

import { Logger } from "@nestjs/common";
import type { PrismaClient, ReminderPreferenceRevision } from "@prisma/client";

import {
  boundedLocalDates,
  currentLocalDate,
  dateColumn,
  localDateMinusDays,
  localScheduleDecisionForDate,
  weekdayForLocalDate,
  weeklyPeriodStart,
} from "./schedule-time";

type ScheduleKind = "daily_advisor" | "behavior_reminder" | "weekly_review";
type SuppressionReason =
  | "disabled"
  | "intensity_disabled"
  | "notification_consent_missing"
  | "missed_cutoff"
  | "quiet_window_exhausted"
  | "weekly_cadence_guard";

interface Candidate {
  kind: ScheduleKind;
  localDate: string;
  periodStart: string;
  scheduledAt: Date;
  cutoffAt: Date;
  requestedMinute: number;
  resolvedLocalMinute: number;
  utcOffsetMinutes: number;
  timeState: "planned" | "missed_cutoff";
  preference: ReminderPreferenceRevision;
  timezone: string;
}

interface SchedulerLogger {
  error(message: string): void;
}

export class RespectfulScheduler {
  constructor(
    private readonly database: PrismaClient,
    private readonly logger: SchedulerLogger = new Logger(RespectfulScheduler.name),
  ) {}

  async runDue(now: Date): Promise<number> {
    const preferences = await this.database.reminderPreference.findMany({ select: { userId: true } });
    let inserted = 0;
    let failedUsers = 0;
    for (const { userId } of preferences) {
      try {
        inserted += await this.runUser(userId, now);
      } catch (error) {
        failedUsers += 1;
        const userReference = createHash("sha256").update(userId).digest("hex").slice(0, 12);
        const category = error instanceof RangeError
          ? "invalid_timezone"
          : typeof error === "object" && error !== null && "code" in error
            ? "database_error"
            : "unexpected_error";
        this.logger.error(JSON.stringify({
          event: "respectful_scheduler_user_failed",
          user_reference: userReference,
          error_category: category,
        }));
      }
    }
    if (failedUsers > 0) {
      this.logger.error(JSON.stringify({
        event: "respectful_scheduler_pass_completed_with_failures",
        failed_users: failedUsers,
      }));
    }
    return inserted;
  }

  private candidateForKind(
    now: Date,
    localDate: string,
    kind: ScheduleKind,
    revisions: ReminderPreferenceRevision[],
  ): Candidate | null {
    for (let index = revisions.length - 1; index >= 0; index -= 1) {
      const preference = revisions[index]!;
      const minute = kind === "daily_advisor"
        ? preference.advisorMinute
        : kind === "behavior_reminder" ? preference.behaviorMinute : preference.weeklyMinute;
      const cutoff = kind === "weekly_review" ? 240 : 120;
      const decision = localScheduleDecisionForDate({
        now,
        timezone: preference.timezone,
        localDate,
        localMinute: minute,
        cutoffMinutes: cutoff,
      });
      const nextRevision = revisions[index + 1];
      if (decision.scheduledAt < preference.effectiveAt) continue;
      if (nextRevision && decision.scheduledAt >= nextRevision.effectiveAt) continue;
      if (kind === "weekly_review" && weekdayForLocalDate(localDate) !== preference.weeklyDay) return null;
      if (decision.state === "not_due") return null;
      return {
        kind,
        localDate: decision.localDate,
        periodStart: kind === "weekly_review" ? weeklyPeriodStart(decision.localDate) : decision.localDate,
        scheduledAt: decision.scheduledAt,
        cutoffAt: decision.cutoffAt,
        requestedMinute: minute,
        resolvedLocalMinute: decision.resolvedLocalMinute,
        utcOffsetMinutes: decision.utcOffsetMinutes,
        timeState: decision.state,
        preference,
        timezone: preference.timezone,
      };
    }
    return null;
  }

  private candidatesForDate(
    now: Date,
    localDate: string,
    revisions: ReminderPreferenceRevision[],
  ): Candidate[] {
    return (["daily_advisor", "behavior_reminder", "weekly_review"] as const)
      .map((kind) => this.candidateForKind(now, localDate, kind, revisions))
      .filter((candidate): candidate is Candidate => candidate !== null);
  }

  private async runUser(userId: string, now: Date): Promise<number> {
    return this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE`;
      await tx.schedulerWatermark.createMany({ data: [{ userId }], skipDuplicates: true });
      await tx.$queryRaw`SELECT "user_id" FROM "scheduler_watermarks" WHERE "user_id" = ${userId}::uuid FOR UPDATE`;
      const [preference, revisions, user, privacy, notification, watermark] = await Promise.all([
        tx.reminderPreference.findUnique({ where: { userId } }),
        tx.reminderPreferenceRevision.findMany({ where: { userId }, orderBy: { version: "asc" } }),
        tx.user.findUnique({ where: { id: userId } }),
        tx.privacyReconciliation.findUnique({ where: { id: "global" } }),
        tx.consentRecord.findFirst({
          where: { userId, consentType: "notifications" }, orderBy: { epoch: "desc" },
        }),
        tx.schedulerWatermark.findUniqueOrThrow({ where: { userId } }),
      ]);
      if (!preference || revisions.length === 0 || !user || user.status !== "active" || privacy?.status !== "ready") return 0;
      const firstRevision = revisions[0]!;
      const dates = boundedLocalDates(
        watermark.lastLocalDate,
        now,
        user.timezone,
        8,
        currentLocalDate(firstRevision.effectiveAt, firstRevision.timezone),
      );
      let inserted = 0;
      for (const localDate of dates) {
        for (const candidate of this.candidatesForDate(now, localDate, revisions)) {
          const existing = await tx.schedulePlan.findUnique({
            where: { userId_kind_periodStart: {
              userId, kind: candidate.kind, periodStart: dateColumn(candidate.periodStart),
            } },
          });
          if (existing) continue;
          let reason: SuppressionReason | null = null;
          if (!candidate.preference.enabled) reason = "disabled";
          else if (candidate.kind === "behavior_reminder" && candidate.preference.intensity !== "standard") reason = "intensity_disabled";
          else if (this.isQuiet(
            candidate.resolvedLocalMinute,
            candidate.preference.quietStartMinute,
            candidate.preference.quietEndMinute,
          )) {
            reason = "quiet_window_exhausted";
          } else if (!notification?.granted) reason = "notification_consent_missing";
          else if (candidate.timeState === "missed_cutoff") reason = "missed_cutoff";
          else if (candidate.kind === "weekly_review") {
            const recent = await tx.schedulePlan.findFirst({
              where: {
                userId,
                kind: "weekly_review",
                status: "planned",
                localDate: { gte: localDateMinusDays(candidate.localDate, 6), lt: dateColumn(candidate.localDate) },
              },
              orderBy: { localDate: "desc" },
            });
            if (recent) reason = "weekly_cadence_guard";
          }
          await tx.schedulePlan.create({ data: {
            userId,
            kind: candidate.kind,
            localDate: dateColumn(candidate.localDate),
            periodStart: dateColumn(candidate.periodStart),
            timezone: candidate.timezone,
            scheduledAt: candidate.scheduledAt,
            cutoffAt: candidate.cutoffAt,
            requestedMinute: candidate.requestedMinute,
            resolvedLocalMinute: candidate.resolvedLocalMinute,
            utcOffsetMinutes: candidate.utcOffsetMinutes,
            preferenceVersion: candidate.preference.version,
            notificationConsentEpoch: reason ? null : notification!.epoch,
            status: reason ? "suppressed" : "planned",
            suppressionReason: reason,
          } });
          inserted += 1;
        }
      }
      const lastEvaluatedAt = !watermark.lastEvaluatedAt || now > watermark.lastEvaluatedAt
        ? now : watermark.lastEvaluatedAt;
      const evaluatedLocalDate = dateColumn(dates.at(-1) ?? watermark.lastLocalDate?.toISOString().slice(0, 10) ?? "1970-01-01");
      const lastLocalDate = !watermark.lastLocalDate || evaluatedLocalDate > watermark.lastLocalDate
        ? evaluatedLocalDate : watermark.lastLocalDate;
      await tx.schedulerWatermark.update({ where: { userId }, data: {
        lastEvaluatedAt,
        lastLocalDate,
        timezone: user.timezone,
        updatedAt: new Date(Math.max(Date.now(), watermark.updatedAt.getTime() + 1)),
      } });
      return inserted;
    });
  }

  private isQuiet(minute: number, start: number, end: number): boolean {
    return start < end ? minute >= start && minute < end : minute >= start || minute < end;
  }
}
