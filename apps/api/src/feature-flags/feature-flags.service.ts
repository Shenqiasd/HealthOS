import { Inject, Injectable } from "@nestjs/common";

import { DatabaseService } from "../database/prisma.service";
import type { Prisma } from "@prisma/client";

export type FeatureFlagKey =
  | "feature.daily_recommendations"
  | "feature.weekly_review_share"
  | "feature.channel_delivery"
  | "feature.llm_generation";

export type FeatureFlagScope =
  | { type: "global"; id: "*" }
  | { type: "channel"; id: "apns" | "wecom" };

export type FeatureFlagDecision = {
  enabled: boolean;
  reason: "enabled_revision" | "disabled_revision" | "missing_revision_fail_closed" | "control_epoch_missing_fail_closed";
  version: number;
  control_epoch: string;
};

export type LlmGenerationDecision = {
  feature: FeatureFlagDecision;
  kill_switch: FeatureFlagDecision;
};

@Injectable()
export class FeatureFlagsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async evaluate(key: FeatureFlagKey, scope: FeatureFlagScope): Promise<FeatureFlagDecision> {
    return this.database.$transaction((tx) => this.evaluateInTransaction(tx, key, scope, true),
      { isolationLevel: "ReadCommitted" });
  }

  async evaluateInTransaction(
    tx: Prisma.TransactionClient,
    key: FeatureFlagKey,
    scope: FeatureFlagScope,
    lockEpoch: boolean,
  ): Promise<FeatureFlagDecision> {
      const epoch = await this.controlEpoch(tx, lockEpoch);
      const revision = await tx.safetyControlRevision.findFirst({
        where: {
          controlType: "feature_flag",
          controlKey: key,
          scopeType: scope.type,
          scopeId: scope.id,
        },
        orderBy: { version: "desc" },
        select: { active: true, version: true },
      });
      if (!epoch) {
        return {
          enabled: false,
          reason: "control_epoch_missing_fail_closed",
          version: revision?.version ?? 0,
          control_epoch: "missing",
        };
      }
      return {
        enabled: revision?.active ?? false,
        reason: revision
          ? revision.active ? "enabled_revision" : "disabled_revision"
          : "missing_revision_fail_closed",
        version: revision?.version ?? 0,
        control_epoch: epoch.toString(),
      };
  }

  async evaluateLlmGeneration(
    tx: Prisma.TransactionClient,
    lockEpoch: boolean,
  ): Promise<LlmGenerationDecision> {
    const epoch = await this.controlEpoch(tx, lockEpoch);
    const [feature, killSwitch] = await Promise.all([
      tx.safetyControlRevision.findFirst({
        where: { controlType: "feature_flag", controlKey: "feature.llm_generation", scopeType: "global", scopeId: "*" },
        orderBy: { version: "desc" }, select: { active: true, version: true },
      }),
      tx.safetyControlRevision.findFirst({
        where: { controlType: "kill_switch", controlKey: "llm.generation", scopeType: "global", scopeId: "*" },
        orderBy: { version: "desc" }, select: { active: true, version: true },
      }),
    ]);
    const decision = (
      revision: { active: boolean; version: number } | null,
      missingEnabled: boolean,
    ): FeatureFlagDecision => ({
      enabled: epoch === null ? false : revision?.active ?? missingEnabled,
      reason: epoch === null
        ? "control_epoch_missing_fail_closed"
        : revision
          ? revision.active ? "enabled_revision" : "disabled_revision"
          : "missing_revision_fail_closed",
      version: revision?.version ?? 0,
      control_epoch: epoch?.toString() ?? "missing",
    });
    return {
      feature: decision(feature, false),
      kill_switch: decision(killSwitch, false),
    };
  }

  private async controlEpoch(tx: Prisma.TransactionClient, lock: boolean): Promise<bigint | null> {
    const rows = lock
      ? await tx.$queryRaw<Array<{ version: bigint }>>`SELECT "version" FROM "safety_control_epoch" WHERE "id" = 'global' FOR SHARE`
      : await tx.$queryRaw<Array<{ version: bigint }>>`SELECT "version" FROM "safety_control_epoch" WHERE "id" = 'global'`;
    return rows[0]?.version ?? null;
  }
}
