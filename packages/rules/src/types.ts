export type SafetyClass = "normal" | "caution" | "doctor" | "blocked";
export type RuleOutcome = "action" | "insufficient_data" | "doctor" | "blocked";
export type RiskArea = "sleep_recovery" | "fatty_liver" | "uric_acid" | "waist_weight";
export type ActionCode = "SLEEP_WIND_DOWN" | "SLEEP_WIND_DOWN_LIGHT" | "POST_MEAL_WALK" | "SUGARY_DRINK_SWAP";

export interface RuleInput {
  age_group: "adult" | "minor" | "unknown";
  pregnancy_state: "none" | "pregnant" | "trying" | "unknown";
  serious_conditions: string[];
  diabetes_treatment: boolean;
  medication_affects_advice: boolean;
  eating_disorder_risk: boolean;
  acute_symptoms: boolean;
  mobility_limited: boolean;
  freshness: "current" | "missing" | "stale" | "conflicting";
  signals: Partial<Record<RiskArea, "elevated" | "normal" | "unknown">>;
  rejected_action_codes: ActionCode[];
  untrusted_text?: string;
}

export interface RuleResult {
  outcome: RuleOutcome;
  safetyClass: SafetyClass;
  riskArea: RiskArea | null;
  actionCode: ActionCode | null;
  reasonCode: string;
  provenance: {
    engine: "deterministic-rules-v1";
    signal: RiskArea | null;
    adjusted: boolean;
  };
}
