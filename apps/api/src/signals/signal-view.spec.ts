import { buildSignalView, selectLatestSignalRevision } from "./signal-view";

describe("Map signal view", () => {
  test("selects the highest revision for each signal regardless of query order", () => {
    const latest = selectLatestSignalRevision([
      { signalCode: "sleep_recovery", revision: 2, marker: "current" },
      { signalCode: "fatty_liver", revision: 1, marker: "only" },
      { signalCode: "sleep_recovery", revision: 1, marker: "old" },
    ]);

    expect(latest).toEqual([
      { signalCode: "fatty_liver", revision: 1, marker: "only" },
      { signalCode: "sleep_recovery", revision: 2, marker: "current" },
    ]);
  });

  test("selects one signal and links only an active matching Today action", () => {
    const view = buildSignalView({
      localDate: "2026-07-11",
      selectedCode: "sleep_recovery",
      snapshots: [{
        id: "signal-1",
        signalCode: "sleep_recovery",
        state: "watch",
        trend: "stable",
        confidence: 0.8,
        freshness: "current",
        drivers: [{ code: "validated_rule_signal", source_fact_revision_ids: ["fact-1"] }],
        createdAt: new Date("2026-07-11T03:00:00.000Z"),
      }],
      activeAction: {
        id: "action-1",
        actionCode: "SLEEP_WIND_DOWN",
        riskArea: "sleep_recovery",
        version: 1,
        status: "active",
      },
    });

    expect(view).toMatchObject({
      schema_version: 1,
      local_date: "2026-07-11",
      signals: [{ code: "sleep_recovery", state: "watch", trend: "stable" }],
      selected: {
        code: "sleep_recovery",
        today_action_link: { id: "action-1", code: "SLEEP_WIND_DOWN", version: 1 },
      },
    });
    expect(JSON.stringify(view)).not.toContain("fact-1");
  });

  test("returns no selected detail for an unknown requested signal", () => {
    const view = buildSignalView({
      localDate: "2026-07-11",
      selectedCode: "uric_acid",
      snapshots: [],
      activeAction: null,
    });
    expect(view.selected).toBeNull();
    expect(view.signals).toEqual([]);
  });
});
