import { createHash } from "node:crypto";

import type { RuleResult } from "@healthos/rules";

import { canonicalSha256 } from "../profile/canonical-json";

export type ReleaseStage = "alpha" | "beta";
export type ReviewRoute = "review_required" | "auto_publish" | "fixed_fallback" | "blocked";

export interface ReviewPolicy {
  releaseStage: ReleaseStage;
  normalSamplePercent: number;
  llmEnabled: boolean;
  safetyBundle: string;
  localizationBundle: string;
  templateBundle: string;
}

export interface RouteDecision {
  route: ReviewRoute;
  samplingBucket: number | null;
  policyDigest: string;
}

function sampleBucket(userId: string, localDate: string, signal: string | null): number {
  const digest = createHash("sha256").update(`${userId}:${localDate}:${signal ?? "none"}`).digest();
  return digest.readUInt32BE(0) % 100;
}

export function routeRecommendation(
  result: RuleResult,
  policy: ReviewPolicy,
  identity: { userId: string; localDate: string; bundleAutoPublishEligible: boolean },
): RouteDecision {
  if (!Number.isInteger(policy.normalSamplePercent) || policy.normalSamplePercent < 0 || policy.normalSamplePercent > 100) {
    throw new Error("Review sample percent must be an integer from 0 to 100");
  }
  if (policy.releaseStage === "beta" && policy.normalSamplePercent < 20) {
    throw new Error("Beta review sampling cannot be below 20 percent");
  }
  const policyDigest = canonicalSha256(policy);
  if (result.outcome === "blocked") return { route: "blocked", samplingBucket: null, policyDigest };
  if (result.outcome === "doctor") return { route: "fixed_fallback", samplingBucket: null, policyDigest };
  if (policy.releaseStage === "alpha" || result.safetyClass !== "normal" || result.outcome !== "action") {
    return { route: "review_required", samplingBucket: null, policyDigest };
  }
  const samplingBucket = sampleBucket(identity.userId, identity.localDate, result.riskArea);
  const sampledForReview = samplingBucket < policy.normalSamplePercent;
  return {
    route: identity.bundleAutoPublishEligible && !sampledForReview ? "auto_publish" : "review_required",
    samplingBucket,
    policyDigest,
  };
}

export function renderDeterministicPayload(result: RuleResult): Record<string, unknown> {
  if (result.outcome === "doctor") {
    return { template: "doctor_fixed_boundary_v1", action_code: null, safety_class: "doctor" };
  }
  if (result.outcome !== "action" || !result.actionCode) {
    return { template: "no_action_v1", action_code: null, safety_class: result.safetyClass, reason_code: result.reasonCode };
  }
  return {
    template: "daily_action_v1",
    action_code: result.actionCode,
    safety_class: result.safetyClass,
    risk_area: result.riskArea,
  };
}
