import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import type { RuleResult } from "@healthos/rules";

import { renderDeterministicPayload, routeRecommendation, type ReviewPolicy } from "./recommendation-policy";
import { RULES_ENGINE_ARTIFACT_DIGEST } from "./rule-bundle.service";

const policy: ReviewPolicy = {
  releaseStage: "alpha",
  normalSamplePercent: 20,
  llmEnabled: false,
  safetyBundle: "safety-v1",
  localizationBundle: "zh-CN-v1",
  templateBundle: "template-v1",
};

const action: RuleResult = {
  outcome: "action",
  safetyClass: "normal",
  riskArea: "sleep_recovery",
  actionCode: "SLEEP_WIND_DOWN",
  reasonCode: "ACTION_SELECTED",
  provenance: { engine: "deterministic-rules-v1", signal: "sleep_recovery", adjusted: false },
};

describe("recommendation review policy", () => {
  test("binds the approved rules-engine digest to the exact source artifact", () => {
    const sourceRoot = resolve(__dirname, "../../../../packages/rules/src");
    const files = readdirSync(sourceRoot)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".spec.ts"))
      .sort();
    const artifact = files.map((file) => {
      const source = readFileSync(resolve(sourceRoot, file), "utf8").replace(/[ \t]+$/gm, "");
      return `packages/rules/src/${file}\n${source}`;
    }).join("");
    expect(createHash("sha256").update(artifact).digest("hex")).toBe(RULES_ENGINE_ARTIFACT_DIGEST);
  });

  test("routes alpha, caution, doctor, and blocked conservatively", () => {
    const identity = { userId: "synthetic-user", localDate: "2026-07-11", bundleAutoPublishEligible: true };
    expect(routeRecommendation(action, policy, identity).route).toBe("review_required");
    expect(routeRecommendation({ ...action, safetyClass: "caution" }, { ...policy, releaseStage: "beta" }, identity).route)
      .toBe("review_required");
    expect(routeRecommendation({ ...action, outcome: "doctor", safetyClass: "doctor", actionCode: null }, policy, identity).route)
      .toBe("fixed_fallback");
    expect(routeRecommendation({ ...action, outcome: "blocked", safetyClass: "blocked", actionCode: null }, policy, identity).route)
      .toBe("blocked");
  });

  test("uses stable beta sampling and an explicit per-bundle allowlist", () => {
    const beta = { ...policy, releaseStage: "beta" as const, normalSamplePercent: 20 };
    const identity = { userId: "00000000-0000-4000-8000-000000000002", localDate: "2026-07-11", bundleAutoPublishEligible: true };
    expect(routeRecommendation(action, beta, identity)).toEqual(routeRecommendation(action, beta, identity));
    expect(routeRecommendation(action, beta, identity).route).toBe("auto_publish");
    expect(routeRecommendation(action, beta, { ...identity, bundleAutoPublishEligible: false }).route)
      .toBe("review_required");
    expect(() => routeRecommendation(action, { ...beta, normalSamplePercent: 0 }, identity)).toThrow(/below 20/i);
    expect(() => routeRecommendation(action, { ...beta, normalSamplePercent: 20.5 }, identity)).toThrow(/integer/i);
  });

  test("renders only fixed structured payloads", () => {
    expect(renderDeterministicPayload(action)).toMatchObject({ template: "daily_action_v1", action_code: "SLEEP_WIND_DOWN" });
    expect(renderDeterministicPayload({ ...action, outcome: "doctor", safetyClass: "doctor", actionCode: null }))
      .toEqual({ template: "doctor_fixed_boundary_v1", action_code: null, safety_class: "doctor" });
    expect(renderDeterministicPayload({ ...action, outcome: "insufficient_data", safetyClass: "caution", actionCode: null }))
      .toMatchObject({ template: "no_action_v1", action_code: null });
  });
});
