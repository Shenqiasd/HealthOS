import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

describe("safety-control OpenAPI contract", () => {
  test("requires administrator auth, correlation, optimistic version, and strict scopes", () => {
    const contract = resolve(__dirname, "../../../../packages/contracts/openapi/healthos-v1.yaml");
    const script = String.raw`
      require "yaml"; require "json"
      d = YAML.load_file(ARGV.fetch(0))
      puts JSON.generate({
        list: d.dig("paths", "/admin/safety-controls", "get"),
        mutate: d.dig("paths", "/admin/safety-controls/actions", "post"),
        request: d.dig("components", "schemas", "AdminSafetyControlActionRequest"),
        response: d.dig("components", "schemas", "AdminSafetyControl")
      })
    `;
    const document = JSON.parse(execFileSync("ruby", ["-e", script, contract], { encoding: "utf8" }));
    expect(document.list.security).toEqual([{ adminBearerAuth: [] }]);
    expect(document.mutate.security).toEqual([{ adminBearerAuth: [] }]);
    expect(document.mutate.parameters).toContainEqual({ $ref: "#/components/parameters/AdminCorrelationId" });
    expect(document.mutate.responses).toEqual(expect.objectContaining({ "200": expect.any(Object), "409": expect.any(Object) }));
    expect(document.request.additionalProperties).toBe(false);
    expect(document.request.required).toEqual(expect.arrayContaining([
      "control_type", "control_key", "scope_type", "scope_id", "active",
      "expected_version", "idempotency_key", "reason",
    ]));
    expect(document.request.properties.expected_version.minimum).toBe(0);
    expect(document.request.properties.reason).toEqual({ $ref: "#/components/schemas/SafetyControlReasonCode" });
    expect(document.request.properties.control_key.enum).toContain("feature.llm_generation");
    expect(document.response.properties.control_key.enum).toContain("feature.llm_generation");
    expect(document.response.additionalProperties).toBe(false);
  });
});
