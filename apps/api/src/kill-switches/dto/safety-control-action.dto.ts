import { IsBoolean, IsIn, IsInt, IsString, IsUUID, MaxLength, Min, MinLength } from "class-validator";

export const SAFETY_CONTROL_REASON_CODES = [
  "incident_containment",
  "incident_recovery",
  "staged_rollout",
  "rollout_pause",
  "privacy_containment",
  "safety_review",
  "synthetic_test",
] as const;

export type SafetyControlReasonCode = (typeof SAFETY_CONTROL_REASON_CODES)[number];

export class SafetyControlActionDto {
  @IsIn(["feature_flag", "kill_switch"])
  control_type!: "feature_flag" | "kill_switch";

  @IsIn([
    "global.proactive_messages",
    "channel.delivery",
    "llm.generation",
    "rule.bundle",
    "user.recommendations",
    "review.share",
    "feature.daily_recommendations",
    "feature.weekly_review_share",
    "feature.channel_delivery",
    "feature.llm_generation",
  ])
  control_key!: string;

  @IsIn(["global", "channel", "rule_bundle", "user"])
  scope_type!: "global" | "channel" | "rule_bundle" | "user";

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  scope_id!: string;

  @IsBoolean()
  active!: boolean;

  @IsInt()
  @Min(0)
  expected_version!: number;

  @IsUUID()
  idempotency_key!: string;

  @IsIn(SAFETY_CONTROL_REASON_CODES)
  reason!: SafetyControlReasonCode;
}
