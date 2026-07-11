import { createHash } from "node:crypto";

import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type {
  TodayFreshnessStatus,
  TodayRecoveryViewModel,
  TodayState,
  TodayViewModel,
} from "@healthos/contracts";
import type { Prisma } from "@prisma/client";
import { getAction, type ActionCode } from "@healthos/rules";

import { DatabaseService } from "../database/prisma.service";

interface CurrentFactRow {
  local_date: Date;
  coverage: Prisma.Decimal | null;
  fact_user_id: string;
  health_sync_run_id: string | null;
  fact_server_sequence: bigint | null;
  sync_user_id: string | null;
  sync_server_sequence: bigint | null;
  consent_epoch: number | null;
  sync_status: string | null;
  completed_at: Date | null;
}

const ACTION_DURATION_MINUTES: Readonly<Record<string, number>> = Object.freeze({
  POST_MEAL_WALK: 12,
  SLEEP_WIND_DOWN: 10,
  SLEEP_WIND_DOWN_LIGHT: 5,
  SUGARY_DRINK_SWAP: 1,
});

function localDate(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function dateAgeDays(current: string, previous: string): number {
  const currentDay = Date.parse(`${current}T00:00:00.000Z`);
  const previousDay = Date.parse(`${previous}T00:00:00.000Z`);
  return Math.floor((currentDay - previousDay) / 86_400_000);
}

function jsonObject(value: Prisma.JsonValue): Prisma.JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Prisma.JsonObject
    : null;
}

function cacheIdentity(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hasLighterVariant(code: string): boolean {
  if (!["SLEEP_WIND_DOWN", "SLEEP_WIND_DOWN_LIGHT", "POST_MEAL_WALK", "SUGARY_DRINK_SWAP"].includes(code)) {
    return false;
  }
  return getAction(code as ActionCode).lighterVariant !== null;
}

function recovery(code: Exclude<TodayState, "active_action">): TodayRecoveryViewModel {
  const primaryCommand: TodayRecoveryViewModel["primary_command"] =
    code === "first_launch" ? "open_permissions"
      : code === "clinical_follow_up" ? "open_coach"
        : code === "action_completed" || code === "action_skipped" || code === "action_rejected" ||
          code === "action_expired" || code === "action_replaced" ? "none"
          : "refresh";
  return { code, copy_key: `today.recovery.${code}`, primary_command: primaryCommand };
}

function momo(state: TodayState): TodayViewModel["momo"] {
  if (state === "active_action") return { state: "ready", copy_key: "today.momo.action_ready" };
  if (state === "action_completed") return { state: "celebrate", copy_key: "today.momo.completed" };
  if (state === "clinical_follow_up") return { state: "care", copy_key: "today.momo.clinical_follow_up" };
  if (state === "action_rejected" || state === "action_expired" || state === "action_replaced") {
    return { state: "reset", copy_key: "today.momo.reset" };
  }
  return { state: "waiting", copy_key: `today.momo.${state}` };
}

@Injectable()
export class TodayService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async get(userId: string, correlationId: string, now = new Date()): Promise<TodayViewModel> {
    return this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId}::uuid FOR SHARE`;
      const user = await tx.user.findUnique({ where: { id: userId } });
      const consent = await tx.consentRecord.findFirst({
        where: { userId, consentType: "health_processing" },
        orderBy: { epoch: "desc" },
      });
      const reconciliation = await tx.privacyReconciliation.findUnique({ where: { id: "global" } });
      if (!user || user.status !== "active" || user.deletedAt || !consent?.granted || reconciliation?.status !== "ready") {
        throw new ForbiddenException("Current health-processing authorization is required");
      }

      const today = localDate(now, user.timezone);
      const date = new Date(`${today}T00:00:00.000Z`);
      const latestProfile = await tx.profileSnapshot.findFirst({
        where: { userId, consentEpoch: consent.epoch },
        orderBy: { version: "desc" },
      });
      const publication = await tx.recommendationPublication.findFirst({
        where: {
          snapshot: {
            reviewStatus: "published",
            run: { userId, localDate: date, consentEpoch: consent.epoch },
          },
        },
        include: {
          snapshot: { include: { run: { include: { ruleBundle: true } } } },
        },
        orderBy: { createdAt: "desc" },
      });
      const factRows = publication
        ? await tx.$queryRaw<CurrentFactRow[]>`
            SELECT
              fact."local_date",
              fact."coverage",
              fact."user_id" AS "fact_user_id",
              fact."health_sync_run_id",
              fact."server_sequence" AS "fact_server_sequence",
              sync."user_id" AS "sync_user_id",
              sync."server_sequence" AS "sync_server_sequence",
              sync."consent_epoch",
              sync."status"::text AS "sync_status",
              sync."completed_at"
            FROM "recommendation_run_fact_inputs" input
            JOIN "daily_health_fact_revisions" fact ON fact."id" = input."fact_revision_id"
            LEFT JOIN "health_sync_runs" sync ON sync."id" = fact."health_sync_run_id"
            WHERE input."run_id" = ${publication.snapshot.runId}::uuid
            ORDER BY fact."local_date" DESC, fact."id"
          `
        : await tx.$queryRaw<CurrentFactRow[]>`
            SELECT
              fact."local_date",
              fact."coverage",
              fact."user_id" AS "fact_user_id",
              fact."health_sync_run_id",
              fact."server_sequence" AS "fact_server_sequence",
              sync."user_id" AS "sync_user_id",
              sync."server_sequence" AS "sync_server_sequence",
              sync."consent_epoch",
              sync."status"::text AS "sync_status",
              sync."completed_at"
            FROM "current_daily_health_facts" fact
            JOIN "health_sync_runs" sync ON sync."id" = fact."health_sync_run_id"
            WHERE fact."user_id" = ${userId}::uuid
              AND sync."user_id" = fact."user_id"
              AND sync."server_sequence" = fact."server_sequence"
              AND sync."consent_epoch" = ${consent.epoch}
              AND sync."status" = 'completed'
              AND sync."completed_at" IS NOT NULL
            ORDER BY fact."local_date" DESC
          `;
      const freshness = this.freshness(today, factRows);
      const publicationInputsAuthorized = !publication || (
        factRows.length > 0 &&
        factRows.every((row) =>
          row.fact_user_id === user.id &&
          row.health_sync_run_id !== null &&
          row.fact_server_sequence !== null &&
          row.sync_user_id === user.id &&
          row.sync_server_sequence === row.fact_server_sequence &&
          row.consent_epoch === publication.snapshot.run.consentEpoch &&
          row.sync_status === "completed" &&
          row.completed_at !== null &&
          row.completed_at <= publication.snapshot.run.createdAt
        )
      );
      const activeAssignment = publication ? await tx.actionAssignment.findFirst({
        where: {
          userId,
          localDate: date,
          recommendationSnapshotId: publication.snapshot.id,
          isPrimary: true,
          status: "active",
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }) : null;
      const latestAssignment = activeAssignment ?? (publication ? await tx.actionAssignment.findFirst({
        where: {
          userId,
          localDate: date,
          recommendationSnapshotId: publication.snapshot.id,
          isPrimary: true,
          status: { not: "proposed" },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }) : null);

      let state: TodayState;
      if (!latestProfile) {
        state = "first_launch";
      } else if (!publicationInputsAuthorized) {
        state = "recommendation_withdrawn";
      } else if (freshness.status === "absent") {
        state = publication ? "stale_data" : "first_launch";
      } else if (freshness.status === "stale") {
        state = "stale_data";
      } else if (!publication) {
        state = "awaiting_recommendation";
      } else if (publication.snapshot.run.inputSnapshotId !== latestProfile.id) {
        state = "profile_changed";
      } else if (publication.snapshot.run.ruleBundle.status !== "active") {
        state = "recommendation_withdrawn";
      } else {
        const provenance = jsonObject(publication.snapshot.provenanceJson);
        const ruleKey = typeof provenance?.rule_key === "string" ? provenance.rule_key : null;
        const incidentExists = ruleKey
          ? await tx.safetyIncident.count({ where: { source: `rule:${ruleKey}` } }) > 0
          : true;
        if (incidentExists) {
          state = "recommendation_withdrawn";
        } else if (!latestAssignment) {
          state = "clinical_follow_up";
        } else {
          state = this.actionState(latestAssignment.status);
        }
      }

      const snapshot = publication?.snapshot ?? null;
      const assignment = state === "active_action" ? latestAssignment : null;
      const provenance = snapshot ? jsonObject(snapshot.provenanceJson) : null;
      const ruleResult = provenance ? jsonObject(provenance.rule_result ?? null) : null;
      const actionCode = assignment?.actionCode ?? snapshot?.actionCode ?? null;
      const action = assignment && actionCode ? {
        id: assignment.id,
        code: actionCode,
        version: assignment.version,
        status: "active" as const,
        duration_minutes: ACTION_DURATION_MINUTES[actionCode] ?? 5,
        difficulty: assignment.difficulty === "light" ? "light" as const : "standard" as const,
        reason_key: `reason.${typeof ruleResult?.reasonCode === "string" ? ruleResult.reasonCode.toLowerCase() : "action_selected"}`,
        signal_key: `signal.${snapshot?.riskArea ?? "general"}`,
        commands: {
          complete: true,
          lighter: hasLighterVariant(actionCode),
          swap: true,
          skip: true,
          why: true,
        },
      } : null;
      const generatedAt = typeof provenance?.generated_at === "string"
        ? provenance.generated_at
        : snapshot?.createdAt.toISOString() ?? null;
      const momoView = momo(state);
      const recoveryView = state === "active_action" ? null : recovery(state);
      const identity = cacheIdentity({
        projection_version: "today-v1",
        schema_version: 1,
        user_id: user.id,
        local_date: today,
        state,
        freshness,
        generated_at: generatedAt,
        momo: momoView,
        action,
        recovery: recoveryView,
        snapshot_hash: snapshot?.snapshotHash ?? null,
      });

      return {
        schema_version: 1,
        state,
        local_date: today,
        generated_at: generatedAt,
        cache_identity: identity,
        correlation_id: correlationId,
        freshness,
        momo: momoView,
        action,
        recovery: recoveryView,
      };
    }, { isolationLevel: "RepeatableRead" });
  }

  private freshness(today: string, rows: CurrentFactRow[]): TodayViewModel["freshness"] {
    if (rows.length === 0) return { status: "absent", coverage: null, latest_local_date: null };
    const latest = rows[0]!.local_date.toISOString().slice(0, 10);
    const latestRows = rows.filter((row) => row.local_date.toISOString().slice(0, 10) === latest);
    const coverages = latestRows.map((row) => row.coverage === null ? null : Number(row.coverage));
    const coverage = coverages.some((value) => value === null)
      ? null
      : Math.min(...coverages as number[]);
    const ageDays = dateAgeDays(today, latest);
    let status: TodayFreshnessStatus = ageDays < 0 || ageDays > 2 ? "stale" : "current";
    if (status === "current" && (coverage === null || coverage < 0.8)) status = "partial";
    return { status, coverage, latest_local_date: latest };
  }

  private actionState(status: string): TodayState {
    if (status === "active") return "active_action";
    if (status === "completed") return "action_completed";
    if (status === "skipped") return "action_skipped";
    if (status === "rejected") return "action_rejected";
    if (status === "expired") return "action_expired";
    return "action_replaced";
  }
}
