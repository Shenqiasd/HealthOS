export const HEALTH_METRICS = [
  "steps",
  "active_energy_kcal",
  "exercise_minutes",
  "sleep_minutes",
  "resting_heart_rate_bpm",
  "hrv_ms",
  "workout_minutes",
  "weight_kg",
  "vo2_max",
] as const;

export type HealthMetric = (typeof HEALTH_METRICS)[number];

export interface HealthSourceContribution {
  sourceId: string;
  kind: "phone" | "watch" | "third_party" | "user";
  contribution: number;
}

export interface DailyHealthFactInput {
  localDate: string;
  metric: HealthMetric;
  value: number;
  coverage: number;
  sourceVector: HealthSourceContribution[];
}

export interface HealthSyncBatchInput {
  idempotencyKey: string;
  deviceId: string;
  anchorEpoch: number;
  timezone: string;
  facts: DailyHealthFactInput[];
}

const metricRanges: Record<HealthMetric, { min: number; max: number; integer: boolean }> = {
  steps: { min: 0, max: 200_000, integer: true },
  active_energy_kcal: { min: 0, max: 20_000, integer: false },
  exercise_minutes: { min: 0, max: 1_440, integer: true },
  sleep_minutes: { min: 0, max: 1_440, integer: true },
  resting_heart_rate_bpm: { min: 20, max: 250, integer: false },
  hrv_ms: { min: 0, max: 1_000, integer: false },
  workout_minutes: { min: 0, max: 1_440, integer: true },
  weight_kg: { min: 20, max: 500, integer: false },
  vo2_max: { min: 5, max: 100, integer: false },
};

export function validateHealthBatch(input: HealthSyncBatchInput): void {
  const allowed = new Set(["idempotencyKey", "deviceId", "anchorEpoch", "timezone", "facts"]);
  const unknown = Object.keys(input as object).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`Unknown or raw batch field: ${unknown[0]}`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.idempotencyKey)) {
    throw new Error("Invalid idempotency key");
  }
  if (!input.deviceId || input.deviceId.length > 128) throw new Error("Invalid device ID");
  if (!Number.isInteger(input.anchorEpoch) || input.anchorEpoch < 0) {
    throw new Error("Invalid anchor epoch");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input.timezone }).format();
  } catch {
    throw new Error("Invalid timezone");
  }
  if (!Array.isArray(input.facts) || input.facts.length === 0 || input.facts.length > 500) {
    throw new Error("Health batch must contain 1 to 500 day facts");
  }
  const keys = new Set<string>();
  for (const fact of input.facts) {
    const allowedFact = new Set(["localDate", "metric", "value", "coverage", "sourceVector"]);
    const unknownFact = Object.keys(fact as object).filter((key) => !allowedFact.has(key));
    if (unknownFact.length > 0) throw new Error(`Unknown or raw fact field: ${unknownFact[0]}`);
    const parsedDate = new Date(`${fact.localDate}T00:00:00.000Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(fact.localDate) ||
      Number.isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== fact.localDate
    ) {
      throw new Error("Invalid local date");
    }
    if (!HEALTH_METRICS.includes(fact.metric)) throw new Error("Unknown health metric");
    const key = `${fact.localDate}:${fact.metric}`;
    if (keys.has(key)) throw new Error("Duplicate date and metric in one batch");
    keys.add(key);
    const range = metricRanges[fact.metric];
    if (
      !Number.isFinite(fact.value) ||
      fact.value < range.min ||
      fact.value > range.max ||
      (range.integer && !Number.isInteger(fact.value))
    ) {
      throw new Error(`Metric value is outside the accepted range: ${fact.metric}`);
    }
    if (!Number.isFinite(fact.coverage) || fact.coverage < 0 || fact.coverage > 1) {
      throw new Error("Coverage must be between zero and one");
    }
    if (!Array.isArray(fact.sourceVector) || fact.sourceVector.length === 0) {
      throw new Error("Source vector is required");
    }
    const sources = new Set<string>();
    let contribution = 0;
    for (const source of fact.sourceVector) {
      if (!source.sourceId || sources.has(source.sourceId)) {
        throw new Error("Source vector contains an invalid or duplicate source");
      }
      sources.add(source.sourceId);
      if (!["phone", "watch", "third_party", "user"].includes(source.kind)) {
        throw new Error("Unknown source kind");
      }
      if (!Number.isFinite(source.contribution) || source.contribution < 0 || source.contribution > 1) {
        throw new Error("Invalid source contribution");
      }
      contribution += source.contribution;
    }
    if (Math.abs(contribution - 1) > 0.000_001) {
      throw new Error("Source contributions must sum to one");
    }
  }
}

export function canonicalHealthBatch(input: HealthSyncBatchInput): HealthSyncBatchInput {
  return {
    ...input,
    facts: [...input.facts]
      .sort((left, right) => `${left.localDate}:${left.metric}`.localeCompare(`${right.localDate}:${right.metric}`))
      .map((fact) => ({
        ...fact,
        sourceVector: [...fact.sourceVector]
          .sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
      })),
  };
}
