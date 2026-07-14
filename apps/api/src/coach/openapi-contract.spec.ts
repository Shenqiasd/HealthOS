import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

describe("Coach OpenAPI contract", () => {
  test("defines authenticated strict thread and message APIs", () => {
    const contract = resolve(__dirname, "../../../../packages/contracts/openapi/healthos-v1.yaml");
    const script = String.raw`
      require "yaml"; require "json"
      d = YAML.load_file(ARGV.fetch(0))
      puts JSON.generate({
        create: d.dig("paths", "/coach/threads", "post"),
        send: d.dig("paths", "/coach/threads/{thread_id}/messages", "post"),
        list: d.dig("paths", "/coach/threads/{thread_id}/messages", "get"),
        path_parameters: d.dig("paths", "/coach/threads/{thread_id}/messages", "parameters"),
        create_request: d.dig("components", "schemas", "CoachThreadCreateRequest"),
        send_request: d.dig("components", "schemas", "CoachMessageSendRequest"),
        result: d.dig("components", "schemas", "CoachTurnResult")
      })
    `;
    const document = JSON.parse(execFileSync("ruby", ["-e", script, contract], { encoding: "utf8" }));
    expect(document.create.security).toEqual([{ BearerAuth: [] }]);
    expect(document.send.security).toEqual([{ BearerAuth: [] }]);
    expect(document.list.security).toEqual([{ BearerAuth: [] }]);
    expect(document.path_parameters).toContainEqual(expect.objectContaining({ name: "thread_id", in: "path", required: true }));
    expect(document.create_request.additionalProperties).toBe(false);
    expect(document.create_request.required).toEqual(["client_thread_id", "idempotency_key"]);
    expect(document.send_request.additionalProperties).toBe(false);
    expect(document.send_request.required).toEqual(["idempotency_key", "expected_summary_version", "user_text"]);
    expect(document.result.additionalProperties).toBe(false);
    expect(document.result.required).toEqual(expect.arrayContaining([
      "intent", "short_answer", "reason", "action_code", "safety_class", "source_ids",
      "needs_human_review", "fixed_response", "fixed_response_code", "candidate",
    ]));
  });
});
