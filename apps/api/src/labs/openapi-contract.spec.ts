import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

describe("Labs OpenAPI contract", () => {
  test("defines authenticated bounded intake, evidence, confirmation, and review APIs", () => {
    const contract = resolve(__dirname, "../../../../packages/contracts/openapi/healthos-v1.yaml");
    const script = String.raw`
      require "yaml"; require "json"
      d = YAML.load_file(ARGV.fetch(0))
      puts JSON.generate({
        intake: d.dig("paths", "/labs/documents", "post"),
        finalize: d.dig("paths", "/labs/documents/{document_id}/finalize", "post"),
        confirm: d.dig("paths", "/labs/observations/{observation_id}/confirm", "post"),
        review: d.dig("paths", "/admin/labs/observations/{observation_id}/confirm", "post"),
        intake_request: d.dig("components", "schemas", "LabDocumentIntakeRequest"),
        evidence: d.dig("components", "schemas", "LabEvidenceBox"),
        observation: d.dig("components", "schemas", "LabObservation")
      })
    `;
    const document = JSON.parse(execFileSync("ruby", ["-e", script, contract], { encoding: "utf8" }));
    for (const operation of [document.intake, document.finalize, document.confirm, document.review]) {
      expect(operation.security).toEqual([{ BearerAuth: [] }]);
    }
    expect(document.intake_request.additionalProperties).toBe(false);
    expect(document.intake_request.properties.size_bytes.maximum).toBe(20 * 1024 * 1024);
    expect(document.evidence.additionalProperties).toBe(false);
    expect(document.evidence.required).toEqual(["x", "y", "width", "height"]);
    expect(document.observation.required).toEqual(expect.arrayContaining([
      "normalized_value", "normalized_unit", "evidence_box", "confidence", "confirmation_status",
    ]));
  });
});
