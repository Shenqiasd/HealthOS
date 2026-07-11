export type ReviewSignalCode = "sleep_recovery" | "fatty_liver" | "uric_acid" | "waist_weight";
export type ReviewSignalState = "stable" | "watch" | "unknown";
export type ReviewSignalTrend = "improving" | "stable" | "worsening" | "unknown";
export type ReviewSignalFreshness = "current" | "partial" | "stale" | "unknown";
export type ReviewActionCode = "SLEEP_WIND_DOWN" | "SLEEP_WIND_DOWN_LIGHT" | "POST_MEAL_WALK" | "SUGARY_DRINK_SWAP";

export interface ReviewSourceSignal {
  id: string;
  localDate: string;
  signalCode: ReviewSignalCode;
  state: ReviewSignalState;
  trend: ReviewSignalTrend;
  freshness: ReviewSignalFreshness;
  createdAt?: Date;
}

export interface ReviewSourceAction {
  id: string;
  localDate: string;
  actionCode: ReviewActionCode;
  status: string;
  createdAt?: Date;
}

export interface ReviewSourceFeedback {
  id: string;
  actionAssignmentId: string;
  type: string;
  reasonCode: string | null;
  outcome: "completed" | "skipped" | "replaced" | "no_safe_alternative";
  occurredAt?: Date;
}

export interface DerivedWeeklyReview {
  coverage: number;
  conclusionKey:
    | "review.conclusion.no_data"
    | "review.conclusion.partial_week"
    | "review.conclusion.improving"
    | "review.conclusion.mixed"
    | "review.conclusion.watch"
    | "review.conclusion.stable";
  evidence: Array<{
    signal_code: ReviewSignalCode;
    state: ReviewSignalState;
    trend: ReviewSignalTrend;
    freshness: ReviewSignalFreshness;
    days_observed: number;
  }>;
  friction: {
    code:
      | "review.friction.no_actions"
      | "review.friction.all_skipped"
      | "review.friction.mostly_completed"
      | "review.friction.mixed";
    completed: number;
    skipped: number;
    replaced: number;
  };
  nextActions: Array<{ assignment_id: string; action_code: ReviewActionCode }>;
}

export function deriveWeeklyReview(input: {
  weekStart: string;
  cutoffAt: Date;
  signals: ReviewSourceSignal[];
  actions: ReviewSourceAction[];
  feedback: ReviewSourceFeedback[];
}): DerivedWeeklyReview {
  const signals = input.signals.filter((item) => !item.createdAt || item.createdAt <= input.cutoffAt);
  const actions = input.actions.filter((item) => !item.createdAt || item.createdAt <= input.cutoffAt);
  const feedback = input.feedback.filter((item) => !item.occurredAt || item.occurredAt <= input.cutoffAt);
  const observedDays = new Set(signals.map((item) => item.localDate)).size;
  const coverage = Math.min(7, observedDays) / 7;
  const trends = new Set(signals.map((item) => item.trend));
  let conclusionKey: DerivedWeeklyReview["conclusionKey"];
  if (signals.length === 0) conclusionKey = "review.conclusion.no_data";
  else if (coverage < 1) conclusionKey = "review.conclusion.partial_week";
  else if (trends.has("improving") && trends.has("worsening")) conclusionKey = "review.conclusion.mixed";
  else if (trends.has("improving")) conclusionKey = "review.conclusion.improving";
  else if (signals.some((item) => item.state === "watch")) conclusionKey = "review.conclusion.watch";
  else conclusionKey = "review.conclusion.stable";

  const grouped = new Map<ReviewSignalCode, ReviewSourceSignal[]>();
  for (const item of signals) {
    const values = grouped.get(item.signalCode) ?? [];
    values.push(item);
    grouped.set(item.signalCode, values);
  }
  const evidence = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 3)
    .map(([signalCode, values]) => {
      const ordered = [...values].sort((left, right) =>
        right.localDate.localeCompare(left.localDate) || right.id.localeCompare(left.id));
      const latest = ordered[0]!;
      return {
        signal_code: signalCode,
        state: latest.state,
        trend: latest.trend,
        freshness: latest.freshness,
        days_observed: new Set(values.map((item) => item.localDate)).size,
      };
    });

  const completed = feedback.filter((item) => item.outcome === "completed").length;
  const skipped = feedback.filter((item) => ["skipped", "no_safe_alternative"].includes(item.outcome)).length;
  const replaced = feedback.filter((item) => item.outcome === "replaced").length;
  const frictionCode = actions.length === 0
    ? "review.friction.no_actions"
    : skipped === actions.length
      ? "review.friction.all_skipped"
      : completed > skipped + replaced
        ? "review.friction.mostly_completed"
        : "review.friction.mixed";

  const nextActions = [...actions]
    .filter((item) => item.actionCode.length > 0)
    .sort((left, right) =>
      right.localDate.localeCompare(left.localDate) ||
      left.actionCode.localeCompare(right.actionCode) ||
      (left.createdAt?.getTime() ?? 0) - (right.createdAt?.getTime() ?? 0) ||
      left.id.localeCompare(right.id))
    .filter((item, index, values) => values.findIndex((candidate) => candidate.actionCode === item.actionCode) === index)
    .slice(0, 3)
    .map((item) => ({ assignment_id: item.id, action_code: item.actionCode }));

  return {
    coverage,
    conclusionKey,
    evidence,
    friction: { code: frictionCode, completed, skipped, replaced },
    nextActions,
  };
}
