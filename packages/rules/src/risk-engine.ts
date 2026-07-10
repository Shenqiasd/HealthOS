import { getAction } from "./action-catalog";
import { isRuleInput } from "./input-validator";
import { evaluateSafetyGate, insufficientSignal, invalidInput, noAcceptableAction } from "./safety-policy";
import type { ActionCode, RiskArea, RuleInput, RuleResult } from "./types";

const RISK_PRIORITY: readonly RiskArea[] = [
  "sleep_recovery",
  "fatty_liver",
  "uric_acid",
  "waist_weight",
];

const DEFAULT_ACTION: Readonly<Record<RiskArea, ActionCode>> = {
  sleep_recovery: "SLEEP_WIND_DOWN",
  fatty_liver: "POST_MEAL_WALK",
  uric_acid: "SUGARY_DRINK_SWAP",
  waist_weight: "POST_MEAL_WALK",
};

function adjustedAction(input: RuleInput, initial: ActionCode): ActionCode | null {
  const action = getAction(initial);
  const alternatives = action.swapFamily === "sleep"
    ? [initial, action.lighterVariant]
    : action.swapFamily === "movement"
      ? [initial, "SUGARY_DRINK_SWAP" as const]
      : [initial];
  return alternatives.find((candidate): candidate is ActionCode =>
    candidate !== null &&
    !input.rejected_action_codes.includes(candidate) &&
    !(input.mobility_limited && getAction(candidate).contraindicationTags.includes("mobility_limited"))) ?? null;
}

export function evaluateRule(input: unknown): RuleResult {
  if (!isRuleInput(input)) return invalidInput();
  const gate = evaluateSafetyGate(input);
  if (gate) return gate;
  const riskArea = RISK_PRIORITY.find((risk) => input.signals[risk] === "elevated");
  if (!riskArea) return insufficientSignal();
  const initial = DEFAULT_ACTION[riskArea];
  const actionCode = adjustedAction(input, initial);
  if (!actionCode) return noAcceptableAction();
  const adjusted = actionCode !== initial;
  return {
    outcome: "action",
    safetyClass: adjusted ? "caution" : "normal",
    riskArea,
    actionCode,
    reasonCode: "ACTION_SELECTED",
    provenance: { engine: "deterministic-rules-v1", signal: riskArea, adjusted },
  };
}
