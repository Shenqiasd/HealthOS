import type { RuleInput, RuleResult } from "./types";

function fallback(
  outcome: "insufficient_data" | "doctor" | "blocked",
  reasonCode: string,
): RuleResult {
  return {
    outcome,
    safetyClass: outcome === "insufficient_data" ? "caution" : outcome,
    riskArea: null,
    actionCode: null,
    reasonCode,
    provenance: { engine: "deterministic-rules-v1", signal: null, adjusted: false },
  };
}

export function evaluateSafetyGate(input: RuleInput): RuleResult | null {
  if (input.acute_symptoms) return fallback("blocked", "ACUTE_SYMPTOMS");
  if (
    input.age_group !== "adult" ||
    input.pregnancy_state !== "none" ||
    input.serious_conditions.length > 0 ||
    input.diabetes_treatment ||
    input.medication_affects_advice ||
    input.eating_disorder_risk
  ) {
    return fallback("doctor", "ELIGIBILITY_REQUIRES_CLINICIAN");
  }
  if (input.freshness === "missing") return fallback("insufficient_data", "DATA_MISSING");
  if (input.freshness === "stale") return fallback("insufficient_data", "DATA_STALE");
  if (input.freshness === "conflicting") return fallback("insufficient_data", "DATA_CONFLICTING");
  return null;
}

export function insufficientSignal(): RuleResult {
  return fallback("insufficient_data", "NO_ELIGIBLE_SIGNAL");
}

export function invalidInput(): RuleResult {
  return fallback("blocked", "INVALID_INPUT");
}

export function noAcceptableAction(): RuleResult {
  return fallback("insufficient_data", "NO_ACCEPTABLE_ACTION");
}
