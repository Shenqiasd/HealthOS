import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { FoodRiskLabelCode } from "@healthos/contracts";

import {
  prepareFoodRiskResult,
  type PreparedFoodResult,
} from "../../../apps/worker/src/jobs/food/food-risk-worker";
import type { FoodVisionResult } from "../../../apps/worker/src/jobs/food/food-vision-provider";

interface FoodEvalCase {
  id: string;
  result: {
    meal_presence: FoodVisionResult["mealPresence"];
    meal_completeness: FoodVisionResult["mealCompleteness"];
    overall_confidence: number;
    dishes: Array<{
      code: string;
      confidence: number;
      evidence_box: { x: number; y: number; width: number; height: number };
    }>;
    labels: Array<{
      label: string;
      level: string;
      confidence: number;
      evidence_box: { x: number; y: number; width: number; height: number };
    }>;
  };
  expected_visible_labels: FoodRiskLabelCode[];
  expected_disposition: PreparedFoodResult["dispositionCode"];
}

interface FoodEvalDocument {
  synthetic_only: true;
  cases: FoodEvalCase[];
}

function providerResult(item: FoodEvalCase): FoodVisionResult {
  return {
    mealPresence: item.result.meal_presence,
    mealCompleteness: item.result.meal_completeness,
    overallConfidence: item.result.overall_confidence,
    dishes: item.result.dishes.map((dish) => ({
      code: dish.code,
      confidence: dish.confidence,
      evidenceBox: dish.evidence_box,
    })),
    labels: item.result.labels.map((label) => ({
      label: label.label,
      level: label.level,
      confidence: label.confidence,
      evidenceBox: label.evidence_box,
    })),
  };
}

async function main(): Promise<void> {
  const path = resolve(process.cwd(), "cases/food/synthetic-cases.json");
  const document = JSON.parse(await readFile(path, "utf8")) as FoodEvalDocument;
  assert.equal(document.synthetic_only, true);
  assert.ok(document.cases.length >= 7);

  let predictedVisible = 0;
  let correctVisible = 0;
  let abstentionCases = 0;
  for (const item of document.cases) {
    const prepared = prepareFoodRiskResult(providerResult(item));
    const visible = prepared.labels
      .filter((label) => label.dispositionCode === "visible")
      .map((label) => label.label)
      .sort();
    assert.deepEqual(visible, [...item.expected_visible_labels].sort(), `${item.id}: visible labels`);
    assert.equal(prepared.dispositionCode, item.expected_disposition, `${item.id}: disposition`);
    predictedVisible += visible.length;
    correctVisible += visible.filter((label) => item.expected_visible_labels.includes(label)).length;
    if (visible.length === 0) abstentionCases += 1;
    assert.doesNotMatch(
      JSON.stringify(prepared),
      /"(?:kcal|calories?|proteins?|carbs?|fats?|macros?|macronutrients?|diagnosis|diagnostic|retrain|retraining)"\s*:/i,
      `${item.id}: forbidden output key`,
    );
  }

  const precision = predictedVisible === 0 ? 1 : correctVisible / predictedVisible;
  assert.equal(precision, 1);
  process.stdout.write(`${JSON.stringify({
    status: "pass",
    synthetic_only: true,
    case_count: document.cases.length,
    visible_label_precision: precision,
    abstention_case_count: abstentionCases,
    real_corpus_gate_satisfied: false,
  })}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
