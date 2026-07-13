import { Inject, Injectable } from "@nestjs/common";

import { DatabaseService } from "../database/prisma.service";

export type FeatureFlagKey =
  | "feature.daily_recommendations"
  | "feature.weekly_review_share"
  | "feature.channel_delivery";

export type FeatureFlagScope =
  | { type: "global"; id: "*" }
  | { type: "channel"; id: "apns" | "wecom" };

export type FeatureFlagDecision = {
  enabled: boolean;
  reason: "enabled_revision" | "disabled_revision" | "missing_revision_fail_closed" | "control_epoch_missing_fail_closed";
  version: number;
  control_epoch: string;
};

@Injectable()
export class FeatureFlagsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async evaluate(key: FeatureFlagKey, scope: FeatureFlagScope): Promise<FeatureFlagDecision> {
    return this.database.$transaction(async (tx) => {
      const [epoch] = await tx.$queryRaw<Array<{ version: bigint }>>`
        SELECT "version" FROM "safety_control_epoch" WHERE "id" = 'global' FOR SHARE
      `;
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
        control_epoch: epoch.version.toString(),
      };
    }, { isolationLevel: "ReadCommitted" });
  }
}
