import type { ActionCode, RiskArea, RuleInput } from "./types";

const AGES = new Set(["adult", "minor", "unknown"]);
const PREGNANCY = new Set(["none", "pregnant", "trying", "unknown"]);
const FRESHNESS = new Set(["current", "missing", "stale", "conflicting"]);
const SIGNALS = new Set(["elevated", "normal", "unknown"]);
const RISKS = new Set<RiskArea>(["sleep_recovery", "fatty_liver", "uric_acid", "waist_weight"]);
const ACTIONS = new Set<ActionCode>(["SLEEP_WIND_DOWN", "SLEEP_WIND_DOWN_LIGHT", "POST_MEAL_WALK", "SUGARY_DRINK_SWAP"]);
const INPUT_KEYS = new Set([
  "age_group",
  "pregnancy_state",
  "serious_conditions",
  "diabetes_treatment",
  "medication_affects_advice",
  "eating_disorder_risk",
  "acute_symptoms",
  "mobility_limited",
  "freshness",
  "signals",
  "rejected_action_codes",
  "untrusted_text",
]);

export function isRuleInput(value: unknown): value is RuleInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !INPUT_KEYS.has(key))) return false;
  if (!AGES.has(input.age_group as string) || !PREGNANCY.has(input.pregnancy_state as string)) return false;
  if (!Array.isArray(input.serious_conditions) || input.serious_conditions.some((item) => typeof item !== "string")) return false;
  for (const key of ["diabetes_treatment", "medication_affects_advice", "eating_disorder_risk", "acute_symptoms", "mobility_limited"] as const) {
    if (typeof input[key] !== "boolean") return false;
  }
  if (!FRESHNESS.has(input.freshness as string)) return false;
  if (!input.signals || typeof input.signals !== "object" || Array.isArray(input.signals)) return false;
  if (Object.entries(input.signals).some(([risk, state]) => !RISKS.has(risk as RiskArea) || !SIGNALS.has(state as string))) return false;
  if (!Array.isArray(input.rejected_action_codes) || input.rejected_action_codes.some((code) => !ACTIONS.has(code as ActionCode))) return false;
  return input.untrusted_text === undefined || typeof input.untrusted_text === "string";
}
