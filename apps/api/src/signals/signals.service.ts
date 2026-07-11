import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type { MapViewModel, SignalCode, SignalFreshness, SignalState, SignalTrend } from "@healthos/contracts";
import type { Prisma } from "@prisma/client";

import { DatabaseService } from "../database/prisma.service";
import { buildSignalView, selectLatestSignalRevision } from "./signal-view";

function localDate(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

function drivers(value: Prisma.JsonValue) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is { code: "validated_rule_signal" } =>
    Boolean(item && typeof item === "object" && !Array.isArray(item) && item.code === "validated_rule_signal"));
}

function ruleSource(value: Prisma.JsonValue): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return typeof value.rule_key === "string" ? `rule:${value.rule_key}` : null;
}

@Injectable()
export class SignalsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async get(userId: string, selectedCode?: SignalCode, now = new Date()): Promise<MapViewModel> {
    return this.database.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      const consent = await tx.consentRecord.findFirst({
        where: { userId, consentType: "health_processing" }, orderBy: { epoch: "desc" },
      });
      const privacy = await tx.privacyReconciliation.findUnique({ where: { id: "global" } });
      if (!user || user.status !== "active" || user.deletedAt || !consent?.granted || privacy?.status !== "ready") {
        throw new ForbiddenException("Current health-processing authorization is required");
      }
      const dateString = localDate(now, user.timezone);
      const date = new Date(`${dateString}T00:00:00.000Z`);
      const latestProfile = await tx.profileSnapshot.findFirst({
        where: { userId, consentEpoch: consent.epoch }, orderBy: { version: "desc" },
      });
      const rows = await tx.signalSnapshot.findMany({
        where: {
          userId, localDate: date,
          recommendationSnapshot: {
            reviewStatus: "published",
            run: { inputSnapshotId: latestProfile?.id ?? "00000000-0000-0000-0000-000000000000", ruleBundle: { status: "active" } },
          },
        },
        include: { recommendationSnapshot: true },
        orderBy: [{ signalCode: "asc" }, { revision: "desc" }],
      });
      const incidentSources = [...new Set(rows
        .map((row) => ruleSource(row.recommendationSnapshot?.provenanceJson ?? null))
        .filter((source): source is string => source !== null))];
      const unsafeSources = incidentSources.length === 0 ? new Set<string>() : new Set(
        (await tx.safetyIncident.findMany({
          where: { source: { in: incidentSources } },
          select: { source: true },
        })).map((incident) => incident.source),
      );
      const safeRows = rows.filter((row) => {
        const source = ruleSource(row.recommendationSnapshot?.provenanceJson ?? null);
        return source !== null && !unsafeSources.has(source);
      });
      const latest = selectLatestSignalRevision(safeRows);
      const signalSnapshotIds = latest
        .map((row) => row.recommendationSnapshotId)
        .filter((id): id is string => id !== null);
      const action = await tx.actionAssignment.findFirst({
        where: {
          userId, localDate: date, isPrimary: true, status: "active",
          recommendationSnapshotId: { in: signalSnapshotIds },
        },
        include: { recommendationSnapshot: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      return buildSignalView({
        localDate: dateString,
        ...(selectedCode ? { selectedCode } : {}),
        snapshots: latest.map((row) => ({
          id: row.id,
          signalCode: row.signalCode as SignalCode,
          state: row.state as SignalState,
          trend: row.trend as SignalTrend,
          confidence: Number(row.confidence),
          freshness: row.freshness as SignalFreshness,
          drivers: drivers(row.driversJson),
          createdAt: row.createdAt,
        })),
        activeAction: action?.actionCode && action.recommendationSnapshot.riskArea ? {
          id: action.id,
          actionCode: action.actionCode as "SLEEP_WIND_DOWN" | "SLEEP_WIND_DOWN_LIGHT" | "POST_MEAL_WALK" | "SUGARY_DRINK_SWAP",
          riskArea: action.recommendationSnapshot.riskArea as SignalCode,
          version: action.version,
          status: "active",
        } : null,
      });
    }, { isolationLevel: "RepeatableRead" });
  }
}
