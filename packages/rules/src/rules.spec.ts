import { ACTION_CATALOG, getAction } from "./action-catalog";
import { evaluateRule } from "./risk-engine";
import { approveBundle, createDraftBundle, isPublishable } from "./rule-bundle";
import type { RuleInput } from "./types";

const base: RuleInput = {
  age_group: "adult",
  pregnancy_state: "none",
  serious_conditions: [],
  diabetes_treatment: false,
  medication_affects_advice: false,
  eating_disorder_risk: false,
  acute_symptoms: false,
  mobility_limited: false,
  freshness: "current",
  signals: {},
  rejected_action_codes: [],
};

describe("deterministic rules and safety", () => {
  test.each([
    [{ acute_symptoms: true }, "blocked", "ACUTE_SYMPTOMS"],
    [{ age_group: "minor" }, "doctor", "ELIGIBILITY_REQUIRES_CLINICIAN"],
    [{ pregnancy_state: "pregnant" }, "doctor", "ELIGIBILITY_REQUIRES_CLINICIAN"],
    [{ serious_conditions: ["synthetic"] }, "doctor", "ELIGIBILITY_REQUIRES_CLINICIAN"],
    [{ diabetes_treatment: true }, "doctor", "ELIGIBILITY_REQUIRES_CLINICIAN"],
    [{ medication_affects_advice: true }, "doctor", "ELIGIBILITY_REQUIRES_CLINICIAN"],
    [{ eating_disorder_risk: true }, "doctor", "ELIGIBILITY_REQUIRES_CLINICIAN"],
    [{ freshness: "missing" }, "insufficient_data", "DATA_MISSING"],
    [{ freshness: "stale" }, "insufficient_data", "DATA_STALE"],
    [{ freshness: "conflicting" }, "insufficient_data", "DATA_CONFLICTING"],
  ] as const)("enforces gate %j", (override, outcome, reasonCode) => {
    const result = evaluateRule({ ...base, ...override } as RuleInput);
    expect(result.outcome).toBe(outcome);
    expect(result.reasonCode).toBe(reasonCode);
    expect(result.actionCode).toBeNull();
  });

  test.each([
    ["sleep_recovery", "SLEEP_WIND_DOWN"],
    ["fatty_liver", "POST_MEAL_WALK"],
    ["uric_acid", "SUGARY_DRINK_SWAP"],
    ["waist_weight", "POST_MEAL_WALK"],
  ] as const)("selects one %s action", (risk, action) => {
    expect(evaluateRule({ ...base, signals: { [risk]: "elevated" } })).toMatchObject({
      outcome: "action", safetyClass: "normal", riskArea: risk, actionCode: action,
    });
  });

  test("uses priority, contraindication swaps, lighter variants, and abstention", () => {
    expect(evaluateRule({ ...base, signals: { sleep_recovery: "elevated", fatty_liver: "elevated" } }).riskArea)
      .toBe("sleep_recovery");
    expect(evaluateRule({ ...base, mobility_limited: true, signals: { fatty_liver: "elevated" } }))
      .toMatchObject({ actionCode: "SUGARY_DRINK_SWAP", safetyClass: "caution" });
    expect(evaluateRule({ ...base, rejected_action_codes: ["SLEEP_WIND_DOWN"], signals: { sleep_recovery: "elevated" } }))
      .toMatchObject({ actionCode: "SLEEP_WIND_DOWN_LIGHT", safetyClass: "caution" });
    expect(evaluateRule({ ...base, rejected_action_codes: ["POST_MEAL_WALK"], signals: { waist_weight: "elevated" } }))
      .toMatchObject({ actionCode: "SUGARY_DRINK_SWAP", safetyClass: "caution" });
    expect(evaluateRule(base)).toMatchObject({ outcome: "insufficient_data", reasonCode: "NO_ELIGIBLE_SIGNAL" });
  });

  test("never returns a rejected or contraindicated substitute", () => {
    expect(evaluateRule({
      ...base,
      rejected_action_codes: ["SLEEP_WIND_DOWN", "SLEEP_WIND_DOWN_LIGHT"],
      signals: { sleep_recovery: "elevated" },
    })).toMatchObject({ outcome: "insufficient_data", actionCode: null, reasonCode: "NO_ACCEPTABLE_ACTION" });
    expect(evaluateRule({
      ...base,
      mobility_limited: true,
      rejected_action_codes: ["SUGARY_DRINK_SWAP"],
      signals: { fatty_liver: "elevated" },
    })).toMatchObject({ outcome: "insufficient_data", actionCode: null, reasonCode: "NO_ACCEPTABLE_ACTION" });
  });

  test.each([
    null,
    [],
    {},
    { ...base, diabetes_treatment: undefined },
    { ...base, freshness: "future" },
    { ...base, serious_conditions: "synthetic" },
    { ...base, serious_conditions: [1] },
    { ...base, signals: null },
    { ...base, signals: [] },
    { ...base, signals: { unknown_signal: "elevated" } },
    { ...base, signals: { sleep_recovery: "severe" } },
    { ...base, rejected_action_codes: "SLEEP_WIND_DOWN" },
    { ...base, rejected_action_codes: ["UNKNOWN_ACTION"] },
    { ...base, untrusted_text: 42 },
    { ...base, unexpected: true },
  ])("fails closed for malformed runtime input %#", (input) => {
    expect(evaluateRule(input)).toMatchObject({
      outcome: "blocked",
      safetyClass: "blocked",
      actionCode: null,
      reasonCode: "INVALID_INPUT",
    });
  });

  test("catalog entries are complete", () => {
    expect(Object.keys(ACTION_CATALOG)).toHaveLength(4);
    expect(getAction("POST_MEAL_WALK").contraindicationTags).toContain("mobility_limited");
    expect(getAction("SLEEP_WIND_DOWN_LIGHT").lighterVariant).toBeNull();
  });

  test("deep-freezes the public action catalog and nested safety metadata", () => {
    expect(Object.isFrozen(ACTION_CATALOG)).toBe(true);
    expect(Object.values(ACTION_CATALOG).every((action) => Object.isFrozen(action))).toBe(true);
    expect(Object.values(ACTION_CATALOG).every((action) => Object.isFrozen(action.contraindicationTags))).toBe(true);
    expect(() => {
      (getAction("POST_MEAL_WALK").contraindicationTags as string[]).splice(0);
    }).toThrow();
    expect(evaluateRule({ ...base, mobility_limited: true, signals: { fatty_liver: "elevated" } }))
      .toMatchObject({ actionCode: "SUGARY_DRINK_SWAP", safetyClass: "caution" });
  });
});

describe("rule bundle approval", () => {
  const hash = "a".repeat(64);

  test("requires valid identity and distinct role approvals without publishing", () => {
    expect(() => createDraftBundle("", hash)).toThrow(/identity/i);
    expect(() => createDraftBundle("v1", "bad")).toThrow(/identity/i);
    const draft = createDraftBundle("v1", hash);
    expect(Object.isFrozen(draft)).toBe(true);
    expect(Object.isFrozen(draft.approvals)).toBe(true);
    expect(isPublishable(draft)).toBe(false);
    const technical = approveBundle(draft, {
      role: "technical", actorId: "tech-owner", approvedAt: "2026-07-10T00:00:00.000Z",
    });
    expect(technical.status).toBe("approval_pending");
    expect(() => approveBundle(technical, {
      role: "technical", actorId: "other", approvedAt: "2026-07-10T00:00:00.000Z",
    })).toThrow(/already/i);
    expect(() => approveBundle(technical, {
      role: "medical", actorId: "tech-owner", approvedAt: "2026-07-10T00:00:00.000Z",
    })).toThrow(/distinct/i);
    const approved = approveBundle(technical, {
      role: "medical", actorId: "medical-owner", approvedAt: "2026-07-10T00:00:00.000Z",
    });
    expect(approved.status).toBe("approved_not_published");
    expect(isPublishable(approved)).toBe(true);
    expect(approved.approvals.every((approval) => Object.isFrozen(approval))).toBe(true);
    expect(new Set(approved.approvals.map((approval) => approval.bundleDigest)).size).toBe(1);
    expect(() => approveBundle(draft, {
      role: "technical", actorId: "", approvedAt: "bad",
    })).toThrow(/approval/i);
  });

  test("rejects malformed approval collections", () => {
    const draft = createDraftBundle("v1", hash);
    expect(isPublishable({ ...draft, status: "approved_not_published" })).toBe(false);
    expect(() => approveBundle({ ...draft }, {
      role: "technical", actorId: "tech-owner", approvedAt: "2026-07-10T00:00:00.000Z",
    })).toThrow(/trusted immutable/i);
    const forged = {
      version: "v1",
      contentHash: hash,
      status: "approved_not_published" as const,
      approvals: [
        { role: "technical" as const, actorId: "tech", approvedAt: "2026-07-10T00:00:00.000Z", bundleDigest: "b".repeat(64) },
        { role: "medical" as const, actorId: "medical", approvedAt: "2026-07-10T00:00:00.000Z", bundleDigest: "b".repeat(64) },
      ],
    };
    expect(isPublishable(forged)).toBe(false);
  });

  test("binds approvals to the immutable version and content", () => {
    const technical = approveBundle(createDraftBundle("v1", hash), {
      role: "technical", actorId: "tech", approvedAt: "2026-07-10T00:00:00.000Z",
    });
    const approved = approveBundle(technical, {
      role: "medical", actorId: "medical", approvedAt: "2026-07-10T00:00:00.000Z",
    });
    expect(isPublishable({ ...approved, version: "v2" })).toBe(false);
    expect(isPublishable({ ...approved, contentHash: "b".repeat(64) })).toBe(false);
    expect(() => approveBundle(technical, {
      role: "invalid" as "medical", actorId: "medical", approvedAt: "2026-07-10T00:00:00.000Z",
    })).toThrow(/approval/i);
  });
});
