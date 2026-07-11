import assert from "node:assert/strict";
import test from "node:test";

import { deriveWeeklyReview } from "./weekly-review-projector";

const weekStart = "2026-07-06";
const cutoffAt = new Date("2026-07-13T00:00:00.000Z");

function signal(day: number, trend: "improving" | "stable" | "worsening" = "stable") {
  const date = new Date(Date.UTC(2026, 6, 6 + day)).toISOString().slice(0, 10);
  return {
    id: `signal-${day}`,
    localDate: date,
    signalCode: "sleep_recovery" as const,
    state: trend === "worsening" ? "watch" as const : "stable" as const,
    trend,
    freshness: "current" as const,
  };
}

test("derives one full-week improving conclusion without health values", () => {
  const result = deriveWeeklyReview({
    weekStart,
    cutoffAt,
    signals: Array.from({ length: 7 }, (_, day) => signal(day, day === 6 ? "improving" : "stable")),
    actions: [{
      id: "assignment-1", localDate: "2026-07-12", actionCode: "SLEEP_WIND_DOWN", status: "completed",
    }],
    feedback: [{
      id: "feedback-1", actionAssignmentId: "assignment-1", type: "complete",
      reasonCode: null, outcome: "completed",
    }],
  });

  assert.equal(result.coverage, 1);
  assert.equal(result.conclusionKey, "review.conclusion.improving");
  assert.deepEqual(result.friction, {
    code: "review.friction.mostly_completed", completed: 1, skipped: 0, replaced: 0,
  });
  assert.deepEqual(result.nextActions, [{ assignment_id: "assignment-1", action_code: "SLEEP_WIND_DOWN" }]);
  assert.equal(result.evidence.length, 1);
  assert.equal(JSON.stringify(result).includes("value"), false);
});

test("reports an honest partial week with no invented action", () => {
  const result = deriveWeeklyReview({
    weekStart,
    cutoffAt,
    signals: [signal(0), signal(2)],
    actions: [],
    feedback: [],
  });

  assert.equal(result.coverage, 2 / 7);
  assert.equal(result.conclusionKey, "review.conclusion.partial_week");
  assert.equal(result.friction.code, "review.friction.no_actions");
  assert.deepEqual(result.nextActions, []);
});

test("uses fixed mixed and all-skipped semantics from immutable source states", () => {
  const signals = Array.from({ length: 7 }, (_, day) => signal(day));
  signals[5] = signal(5, "improving");
  signals[6] = signal(6, "worsening");
  const result = deriveWeeklyReview({
    weekStart,
    cutoffAt,
    signals,
    actions: [
      { id: "assignment-a", localDate: "2026-07-10", actionCode: "POST_MEAL_WALK", status: "skipped" },
      { id: "assignment-b", localDate: "2026-07-11", actionCode: "SLEEP_WIND_DOWN", status: "skipped" },
    ],
    feedback: [
      { id: "feedback-a", actionAssignmentId: "assignment-a", type: "skip", reasonCode: "no_time", outcome: "skipped" },
      { id: "feedback-b", actionAssignmentId: "assignment-b", type: "skip", reasonCode: "tired", outcome: "skipped" },
    ],
  });

  assert.equal(result.conclusionKey, "review.conclusion.mixed");
  assert.equal(result.friction.code, "review.friction.all_skipped");
  assert.deepEqual(result.nextActions.map((item) => item.action_code), ["SLEEP_WIND_DOWN", "POST_MEAL_WALK"]);
});

test("excludes late signal, action, and feedback evidence after the immutable cutoff", () => {
  const before = new Date("2026-07-12T23:59:59.000Z");
  const after = new Date("2026-07-13T00:00:01.000Z");
  const result = deriveWeeklyReview({
    weekStart,
    cutoffAt,
    signals: [
      { ...signal(0), createdAt: before },
      { ...signal(1, "improving"), createdAt: after },
    ],
    actions: [
      { id: "before", localDate: "2026-07-12", actionCode: "SLEEP_WIND_DOWN", status: "completed", createdAt: before },
      { id: "late", localDate: "2026-07-12", actionCode: "POST_MEAL_WALK", status: "completed", createdAt: after },
    ],
    feedback: [
      { id: "before-feedback", actionAssignmentId: "before", type: "complete", reasonCode: null, outcome: "completed", occurredAt: before },
      { id: "late-feedback", actionAssignmentId: "late", type: "complete", reasonCode: null, outcome: "completed", occurredAt: after },
    ],
  });

  assert.equal(result.coverage, 1 / 7);
  assert.equal(result.conclusionKey, "review.conclusion.partial_week");
  assert.deepEqual(result.nextActions, [{ assignment_id: "before", action_code: "SLEEP_WIND_DOWN" }]);
});

test("does not infer a cutoff-time outcome from an assignment mutated after cutoff", () => {
  const result = deriveWeeklyReview({
    weekStart,
    cutoffAt,
    signals: [],
    actions: [{
      id: "mutated-later",
      localDate: "2026-07-12",
      actionCode: "SLEEP_WIND_DOWN",
      status: "completed",
      createdAt: new Date("2026-07-12T01:00:00.000Z"),
    }],
    feedback: [{
      id: "late-completion",
      actionAssignmentId: "mutated-later",
      type: "complete",
      reasonCode: null,
      outcome: "completed",
      occurredAt: new Date("2026-07-13T00:00:01.000Z"),
    }],
  });

  assert.deepEqual(result.friction, {
    code: "review.friction.mixed", completed: 0, skipped: 0, replaced: 0,
  });
});
