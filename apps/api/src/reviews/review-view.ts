import {
  buildWeeklyReviewSharePayload,
  type ReviewConclusionKey,
  type ReviewNextAction,
  type ReviewSharePayload,
  type ReviewShareVariant,
  type WeeklyReviewViewModel,
} from "@healthos/contracts";

export interface StoredReviewView {
  id: string;
  weekStart: Date;
  cutoffAt: Date;
  revision: number;
  coverage: number;
  conclusion: ReviewConclusionKey;
  evidence: WeeklyReviewViewModel["evidence"];
  friction: WeeklyReviewViewModel["friction"];
  nextActions: ReviewNextAction[];
  createdAt: Date;
}

function date(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function buildReviewView(snapshot: StoredReviewView): WeeklyReviewViewModel {
  return {
    schema_version: 1,
    id: snapshot.id,
    week_start: date(snapshot.weekStart),
    week_end: date(new Date(snapshot.weekStart.getTime() + 6 * 86_400_000)),
    cutoff_at: snapshot.cutoffAt.toISOString(),
    revision: snapshot.revision,
    coverage: snapshot.coverage,
    conclusion_key: snapshot.conclusion,
    evidence: snapshot.evidence,
    friction: snapshot.friction,
    next_actions: snapshot.nextActions,
    generated_at: snapshot.createdAt.toISOString(),
  };
}

export function buildSharePayload(snapshot: StoredReviewView, variant: ReviewShareVariant): ReviewSharePayload {
  return buildWeeklyReviewSharePayload(snapshot, variant);
}
