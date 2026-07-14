import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

describe("Food Risk Scan OpenAPI contract", () => {
  test("defines bounded authenticated APIs and structurally excludes precision nutrition", () => {
    const contract = resolve(__dirname, "../../../../packages/contracts/openapi/healthos-v1.yaml");
    const script = String.raw`
      require "yaml"; require "json"
      d = YAML.load_file(ARGV.fetch(0))
      puts JSON.generate({
        intake: d.dig("paths", "/food/scans", "post"),
        finalize: d.dig("paths", "/food/scans/{scan_id}/finalize", "post"),
        correction: d.dig("paths", "/food/scans/{scan_id}/corrections", "post"),
        intake_request: d.dig("components", "schemas", "FoodScanIntakeRequest"),
        correction_request: d.dig("components", "schemas", "FoodCorrectionRequest"),
        scan: d.dig("components", "schemas", "FoodScan")
      })
    `;
    const document = JSON.parse(execFileSync("ruby", ["-e", script, contract], { encoding: "utf8" }));
    for (const operation of [document.intake, document.finalize, document.correction]) {
      expect(operation.security).toEqual([{ BearerAuth: [] }]);
    }
    expect(document.intake_request.additionalProperties).toBe(false);
    expect(document.intake_request.properties.size_bytes.maximum).toBe(10 * 1024 * 1024);
    expect(document.correction_request.additionalProperties).toBe(false);
    expect(document.scan.additionalProperties).toBe(false);
    expect(JSON.stringify(document)).not.toMatch(/kcal|calorie|protein|carbs|fat|macro|diagnos|retrain/i);
  });
});
