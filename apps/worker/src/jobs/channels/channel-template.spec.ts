import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { parseChannelTemplate, renderChannelTemplate } from "./channel-template";

test("renders only fixed schedule notification keys", () => {
  assert.deepEqual(renderChannelTemplate("daily_advisor", "/today"), {
    schema_version: 1,
    template: "daily_advisor_v1",
    copy_key: "notification.daily_advisor",
    action_key: "open_today",
    deeplink_path: "/today",
  });
  assert.deepEqual(renderChannelTemplate("behavior_reminder", "/today"), {
    schema_version: 1,
    template: "behavior_reminder_v1",
    copy_key: "notification.behavior_reminder",
    action_key: "open_today",
    deeplink_path: "/today",
  });
  assert.deepEqual(renderChannelTemplate("weekly_review", "/review"), {
    schema_version: 1,
    template: "weekly_review_v1",
    copy_key: "notification.weekly_review",
    action_key: "open_review",
    deeplink_path: "/review",
  });
});

test("rejects unknown schedule kinds and paths instead of accepting free text", () => {
  assert.throws(() => renderChannelTemplate("lab_value" as never, "/today"), /template/i);
  assert.throws(() => renderChannelTemplate("daily_advisor", "/today?uric_acid=520"), /path/i);
  assert.throws(() => renderChannelTemplate("daily_advisor", "https://example.com/today"), /path/i);
  assert.throws(() => parseChannelTemplate({
    ...renderChannelTemplate("daily_advisor", "/today"),
    health_text: "ZhangSan HbA1c 7.8",
  }), /non-allowlisted/i);
});

test("contains no external provider client or network transport", () => {
  const source = readFileSync(resolve(__dirname, "channel-delivery-worker.ts"), "utf8");
  assert.doesNotMatch(source, /\bfetch\b|https?:\/\/|axios|apns2|wecom.*secret/i);
});
