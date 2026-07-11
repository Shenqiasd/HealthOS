import type {
  MapViewModel,
  SignalCode,
  SignalFreshness,
  SignalState,
  SignalTrend,
} from "@healthos/contracts";

interface SignalViewRow {
  id: string;
  signalCode: SignalCode;
  state: SignalState;
  trend: SignalTrend;
  confidence: number;
  freshness: SignalFreshness;
  drivers: Array<{ code: "validated_rule_signal"; source_fact_revision_ids?: string[] }>;
  createdAt: Date;
}

interface ActiveActionView {
  id: string;
  actionCode: "SLEEP_WIND_DOWN" | "SLEEP_WIND_DOWN_LIGHT" | "POST_MEAL_WALK" | "SUGARY_DRINK_SWAP";
  riskArea: SignalCode;
  version: number;
  status: "active";
}

export function selectLatestSignalRevision<T extends { signalCode: string; revision: number }>(rows: T[]): T[] {
  const latest = new Map<string, T>();
  for (const row of rows) {
    const current = latest.get(row.signalCode);
    if (!current || row.revision > current.revision) latest.set(row.signalCode, row);
  }
  return [...latest.values()].sort((left, right) => left.signalCode.localeCompare(right.signalCode));
}

export function buildSignalView(input: {
  localDate: string;
  selectedCode?: SignalCode;
  snapshots: SignalViewRow[];
  activeAction: ActiveActionView | null;
}): MapViewModel {
  const ordered = [...input.snapshots].sort((left, right) => left.signalCode.localeCompare(right.signalCode));
  const selected = input.selectedCode
    ? ordered.find((item) => item.signalCode === input.selectedCode) ?? null
    : ordered[0] ?? null;
  const summary = (item: SignalViewRow) => ({
    code: item.signalCode,
    state: item.state,
    trend: item.trend,
    confidence: item.confidence,
    freshness: item.freshness,
  });
  return {
    schema_version: 1,
    local_date: input.localDate,
    generated_at: ordered.length > 0
      ? new Date(Math.max(...ordered.map((item) => item.createdAt.getTime()))).toISOString()
      : null,
    signals: ordered.map(summary),
    selected: selected ? {
      ...summary(selected),
      drivers: selected.drivers.map(() => ({ code: "validated_rule_signal" as const })),
      today_action_link: input.activeAction?.riskArea === selected.signalCode
        ? {
          id: input.activeAction.id,
          code: input.activeAction.actionCode,
          version: input.activeAction.version,
        }
        : null,
    } : null,
  };
}
