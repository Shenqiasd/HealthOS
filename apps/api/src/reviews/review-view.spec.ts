import { buildReviewView, buildSharePayload, type StoredReviewView } from "./review-view";

const snapshot: StoredReviewView = {
  id: "11111111-1111-4111-8111-111111111111",
  weekStart: new Date("2026-07-06T00:00:00.000Z"),
  cutoffAt: new Date("2026-07-13T00:00:00.000Z"),
  revision: 1,
  coverage: 1,
  conclusion: "review.conclusion.improving",
  evidence: [{ signal_code: "sleep_recovery", state: "stable", trend: "improving", freshness: "current", days_observed: 7 }],
  friction: { code: "review.friction.mostly_completed", completed: 4, skipped: 1, replaced: 0 },
  nextActions: [{ assignment_id: "assignment-secret", action_code: "SLEEP_WIND_DOWN" }],
  createdAt: new Date("2026-07-13T00:05:00.000Z"),
};

test("builds an immutable Review view from stored semantic content", () => {
  expect(buildReviewView(snapshot)).toMatchObject({
    schema_version: 1,
    id: snapshot.id,
    week_start: "2026-07-06",
    conclusion_key: "review.conclusion.improving",
    evidence: [{ signal_code: "sleep_recovery", trend: "improving" }],
  });
});

test("redacted sharing removes assignment identity while private export remains explicit", () => {
  const redacted = buildSharePayload(snapshot, "redacted");
  const privatePayload = buildSharePayload(snapshot, "private");

  expect(redacted.next_actions).toEqual([{ action_code: "SLEEP_WIND_DOWN" }]);
  expect(JSON.stringify(redacted)).not.toContain("assignment-secret");
  expect(privatePayload.next_actions).toEqual([{
    assignment_id: "assignment-secret", action_code: "SLEEP_WIND_DOWN",
  }]);
  for (const payload of [redacted, privatePayload]) {
    expect(JSON.stringify(payload)).not.toMatch(/user_id|account|fact_revision|canonical_value|exact_time/);
  }
});
