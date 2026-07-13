import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { localScheduleDecision, minuteIsQuiet, weeklyPeriodStart } from "./schedule-time";

test("simulates fourteen exact local days across three IANA zones", () => {
  for (const timezone of ["Asia/Shanghai", "America/New_York", "Europe/London"]) {
    for (let day = 1; day <= 14; day += 1) {
      const localDate = `2026-07-${String(day).padStart(2, "0")}`;
      const at = localScheduleDecision({
        now: new Date(`${localDate}T12:00:00.000Z`), timezone, localMinute: 8 * 60 + 30, cutoffMinutes: 120,
      });
      assert.match(at.localDate, /^2026-07-/);
      assert.ok(["not_due", "planned", "missed_cutoff"].includes(at.state));
      assert.ok(at.cutoffAt.getTime() > at.scheduledAt.getTime());
    }
  }
});

test("uses Temporal-compatible DST disambiguation in New York", () => {
  const spring = localScheduleDecision({
    now: new Date("2026-03-08T07:35:00.000Z"), timezone: "America/New_York", localMinute: 2 * 60 + 30, cutoffMinutes: 120,
  });
  assert.equal(spring.scheduledAt.toISOString(), "2026-03-08T07:30:00.000Z");
  assert.equal(spring.resolvedLocalMinute, 3 * 60 + 30);
  assert.equal(spring.utcOffsetMinutes, -4 * 60);
  assert.equal(spring.state, "planned");
  const fall = localScheduleDecision({
    now: new Date("2026-11-01T05:35:00.000Z"), timezone: "America/New_York", localMinute: 90, cutoffMinutes: 120,
  });
  assert.equal(fall.scheduledAt.toISOString(), "2026-11-01T05:30:00.000Z");
  assert.equal(fall.state, "planned");
});

test("supports real 30-minute and European IANA transitions", () => {
  const lordHowe = localScheduleDecision({
    now: new Date("2026-10-03T15:50:00.000Z"), timezone: "Australia/Lord_Howe", localMinute: 2 * 60 + 15, cutoffMinutes: 120,
  });
  assert.equal(lordHowe.resolvedLocalMinute, 2 * 60 + 45);
  assert.equal(lordHowe.utcOffsetMinutes, 11 * 60);
  assert.equal(lordHowe.state, "planned");
  const london = localScheduleDecision({
    now: new Date("2026-03-29T01:35:00.000Z"), timezone: "Europe/London", localMinute: 90, cutoffMinutes: 120,
  });
  assert.equal(london.resolvedLocalMinute, 2 * 60 + 30);
  assert.equal(london.utcOffsetMinutes, 60);
});

test("treats cutoff boundaries exactly and implementation has no delivery dependency", () => {
  const atCutoff = localScheduleDecision({
    now: new Date("2026-07-01T02:30:00.000Z"), timezone: "Asia/Shanghai", localMinute: 8 * 60 + 30, cutoffMinutes: 120,
  });
  assert.equal(atCutoff.state, "planned");
  assert.equal(localScheduleDecision({
    now: new Date("2026-07-01T02:30:00.001Z"), timezone: "Asia/Shanghai", localMinute: 8 * 60 + 30, cutoffMinutes: 120,
  }).state, "missed_cutoff");
  const implementation = ["schedule-time.ts", "respectful-scheduler.ts", "respectful-scheduler-dispatcher.ts"]
    .map((file) => readFileSync(resolve(__dirname, file), "utf8")).join("\n");
  assert.doesNotMatch(implementation, /channelOutbox|deliveryAttempt|provider|APNs|WeCom|invokeAuthorizedProvider/i);
});

test("handles cross-midnight quiet hours and stable weekly periods", () => {
  assert.equal(minuteIsQuiet(23 * 60, 22 * 60, 7 * 60), true);
  assert.equal(minuteIsQuiet(6 * 60 + 59, 22 * 60, 7 * 60), true);
  assert.equal(minuteIsQuiet(8 * 60, 22 * 60, 7 * 60), false);
  assert.equal(weeklyPeriodStart("2026-07-05"), "2026-06-29");
  assert.equal(weeklyPeriodStart("2026-07-06"), "2026-07-06");
});
