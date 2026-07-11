import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

describe("operations OpenAPI contract", () => {
  test("uses strict principal, pagination, mutation, and audit-safe schemas", () => {
    const contract = resolve(__dirname, "../../../../packages/contracts/openapi/healthos-v1.yaml");
    const script = String.raw`
      require "yaml"
      require "json"
      document = YAML.load_file(ARGV.fetch(0))
      result = {
        review_security: document.dig("paths", "/admin/review-tasks", "get", "security"),
        mutation_security: document.dig("paths", "/admin/review-tasks/{taskId}/actions", "post", "security"),
        incident_security: document.dig("paths", "/admin/safety-incidents", "get", "security"),
        review: document.dig("components", "schemas", "AdminReviewTask"),
        incident: document.dig("components", "schemas", "AdminSafetyIncident"),
        review_one_of: document.dig("components", "schemas", "AdminReviewWorkflowActionRequest", "oneOf"),
        review_discriminator: document.dig("components", "schemas", "AdminReviewWorkflowActionRequest", "discriminator", "propertyName"),
        review_actions: document.dig("components", "schemas", "AdminReviewWorkflowActionRequest", "discriminator", "mapping")&.keys,
        safety_one_of: document.dig("components", "schemas", "AdminSafetyWorkflowActionRequest", "oneOf"),
        safety_discriminator: document.dig("components", "schemas", "AdminSafetyWorkflowActionRequest", "discriminator", "propertyName"),
        safety_actions: document.dig("components", "schemas", "AdminSafetyWorkflowActionRequest", "discriminator", "mapping")&.keys,
        review_parameters: document.dig("paths", "/admin/review-tasks/{taskId}/actions", "post", "parameters"),
        safety_parameters: document.dig("paths", "/admin/safety-incidents/{incidentId}/actions", "post", "parameters"),
        safety_success: document.dig("paths", "/admin/safety-incidents/{incidentId}/actions", "post", "responses").keys
      }
      puts JSON.generate(result)
    `;
    const document = JSON.parse(execFileSync("ruby", ["-e", script, contract], { encoding: "utf8" }));
    expect(document.review_security).toEqual([{ adminBearerAuth: [] }]);
    expect(document.mutation_security).toEqual([{ adminBearerAuth: [] }]);
    expect(document.incident_security).toEqual([{ adminBearerAuth: [] }]);
    expect(document.review.additionalProperties).toBe(false);
    expect(document.review.properties).not.toHaveProperty("raw_value");
    expect(document.incident.properties).not.toHaveProperty("details_encrypted");
    expect(document.review_one_of).toHaveLength(3);
    expect(document.review_discriminator).toBe("action");
    expect(document.review_actions).toEqual(["claim", "reassign", "release"]);
    expect(document.safety_one_of).toHaveLength(3);
    expect(document.safety_discriminator).toBe("action");
    expect(document.safety_actions).toEqual(["acknowledge", "resolve", "reopen"]);
    expect(document.review_parameters).toContainEqual({ "$ref": "#/components/parameters/AdminCorrelationId" });
    expect(document.safety_parameters).toContainEqual({ "$ref": "#/components/parameters/AdminCorrelationId" });
    expect([...document.review_actions, ...document.safety_actions]).not.toEqual(expect.arrayContaining(["approve", "publish", "reject"]));
    expect(document.safety_success).toContain("200");
    expect(document.safety_success).not.toContain("201");
  });
});
