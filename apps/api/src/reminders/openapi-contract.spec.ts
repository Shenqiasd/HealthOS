import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

describe("reminder OpenAPI contract", () => {
  test("uses authenticated strict versioned preference schemas", () => {
    const contract = resolve(__dirname, "../../../../packages/contracts/openapi/healthos-v1.yaml");
    const script = String.raw`
      require "yaml"; require "json"
      d = YAML.load_file(ARGV.fetch(0))
      puts JSON.generate({
        get_security: d.dig("paths", "/reminders/preferences", "get", "security"),
        get_responses: d.dig("paths", "/reminders/preferences", "get", "responses").keys.sort,
        put_security: d.dig("paths", "/reminders/preferences", "put", "security"),
        request: d.dig("components", "schemas", "ReminderPreferenceUpdateRequest"),
        response: d.dig("components", "schemas", "ReminderPreferenceResponse")
      })
    `;
    const document = JSON.parse(execFileSync("ruby", ["-e", script, contract], { encoding: "utf8" }));
    expect(document.get_security).toEqual([{ BearerAuth: [] }]);
    expect(document.get_responses).toEqual(["200", "401", "403", "503"]);
    expect(document.put_security).toEqual([{ BearerAuth: [] }]);
    expect(document.request.additionalProperties).toBe(false);
    expect(document.request.required).toEqual(expect.arrayContaining([
      "expected_version", "idempotency_key", "enabled", "intensity", "timezone",
      "quiet_hours", "advisor_time", "behavior_time", "weekly_report",
    ]));
    expect(document.response.additionalProperties).toBe(false);
  });
});
