import { execFileSync } from "node:child_process";
import path from "node:path";

describe("Map OpenAPI contract", () => {
  test("parses OpenAPI 3.1 and resolves every internal reference", () => {
    const contract = path.resolve(__dirname, "../../../../packages/contracts/openapi/healthos-v1.yaml");
    const script = String.raw`
      require "yaml"
      document = YAML.load_file(ARGV.fetch(0))
      raise "expected OpenAPI 3.1.0" unless document.fetch("openapi") == "3.1.0"
      references = []
      walk = lambda do |value|
        case value
        when Hash
          value.each do |key, child|
            references << child if key == "$ref"
            walk.call(child)
          end
        when Array
          value.each { |child| walk.call(child) }
        end
      end
      walk.call(document)
      references.each do |reference|
        raise "external reference: #{reference}" unless reference.start_with?("#/")
        current = document
        reference.delete_prefix("#/").split("/").each do |part|
          key = part.gsub("~1", "/").gsub("~0", "~")
          raise "unresolved reference: #{reference}" unless current.is_a?(Hash) && current.key?(key)
          current = current.fetch(key)
        end
      end
      raise "Map endpoint missing" unless document.dig("paths", "/map", "get")
      puts references.length
    `;
    const output = execFileSync("ruby", ["-e", script, contract], { encoding: "utf8" });

    expect(Number(output.trim())).toBeGreaterThan(0);
  });
});
