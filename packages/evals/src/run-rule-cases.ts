import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { evaluateRule } from "@healthos/rules";

type Fixture = {
  id: string;
  input: unknown;
  expected: {
    outcome: string;
    safety_class: string;
    risk_area: string | null;
    allowed_action_codes: string[];
    reason_code: string;
    fallback_code: string | null;
    forbidden_output: string[];
    provenance: { engine: string; signal: string | null; adjusted: boolean };
  };
};

const FIXTURE_KEYS = ["expected", "id", "input"];
const EXPECTED_KEYS = [
  "allowed_action_codes",
  "fallback_code",
  "forbidden_output",
  "outcome",
  "provenance",
  "reason_code",
  "risk_area",
  "safety_class",
];
const PROVENANCE_KEYS = ["adjusted", "engine", "signal"];
const RESULT_KEYS = ["actionCode", "outcome", "provenance", "reasonCode", "riskArea", "safetyClass"];
const RESULT_PROVENANCE_KEYS = ["adjusted", "engine", "signal"];
const OUTCOMES = new Set(["action", "insufficient_data", "doctor", "blocked"]);
const SAFETY_CLASSES = new Set(["normal", "caution", "doctor", "blocked"]);

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseFixture(value: unknown, group: string, index: number): Fixture {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${group}[${index}] must be an object`);
  }
  const item = value as Record<string, unknown>;
  if (!hasExactKeys(item, FIXTURE_KEYS) || typeof item.id !== "string" || !item.id || !item.input || typeof item.input !== "object") {
    throw new Error(`${group}[${index}] has an invalid fixture envelope`);
  }
  if (!item.expected || typeof item.expected !== "object" || Array.isArray(item.expected)) {
    throw new Error(`${item.id} expected must be an object`);
  }
  const expected = item.expected as Record<string, unknown>;
  const provenance = expected.provenance;
  if (
    !hasExactKeys(expected, EXPECTED_KEYS) ||
    !OUTCOMES.has(expected.outcome as string) ||
    !SAFETY_CLASSES.has(expected.safety_class as string) ||
    (expected.risk_area !== null && typeof expected.risk_area !== "string") ||
    !Array.isArray(expected.allowed_action_codes) ||
    expected.allowed_action_codes.some((code) => typeof code !== "string") ||
    typeof expected.reason_code !== "string" ||
    (expected.fallback_code !== null && typeof expected.fallback_code !== "string") ||
    !Array.isArray(expected.forbidden_output) ||
    !expected.forbidden_output.includes("diagnosis") ||
    !expected.forbidden_output.includes("medication_change") ||
    !provenance ||
    typeof provenance !== "object" ||
    Array.isArray(provenance) ||
    !hasExactKeys(provenance as Record<string, unknown>, PROVENANCE_KEYS)
  ) {
    throw new Error(`${item.id} has an invalid expected contract`);
  }
  const typedProvenance = provenance as Record<string, unknown>;
  if (
    typedProvenance.engine !== "deterministic-rules-v1" ||
    (typedProvenance.signal !== null && typeof typedProvenance.signal !== "string") ||
    typeof typedProvenance.adjusted !== "boolean" ||
    (expected.outcome === "action" ? expected.fallback_code !== null : expected.fallback_code !== expected.reason_code)
  ) {
    throw new Error(`${item.id} has invalid fallback or provenance data`);
  }
  return item as Fixture;
}

async function load(group: "golden" | "adversarial"): Promise<Fixture[]> {
  const parsed: unknown = JSON.parse(await readFile(join(process.cwd(), "cases", group, "cases.json"), "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${group} fixture file must be an array`);
  return parsed.map((item, index) => parseFixture(item, group, index));
}

async function main(): Promise<void> {
  const golden = await load("golden");
  const adversarial = await load("adversarial");
  if (golden.length !== 50 || adversarial.length !== 30) {
    throw new Error(`Expected 50 golden and 30 adversarial cases; got ${golden.length}/${adversarial.length}`);
  }

  const all = [...golden, ...adversarial];
  if (new Set(all.map((item) => item.id)).size !== all.length) throw new Error("Fixture IDs must be unique");
  if (new Set(all.map((item) => canonical({ input: item.input, expected: item.expected }))).size !== all.length) {
    throw new Error("Every fixture input and expected scenario must be unique");
  }

  const failures: string[] = [];
  for (const item of all) {
    const result = evaluateRule(item.input);
    const fallbackCode = result.outcome === "action" ? null : result.reasonCode;
    const resultText = canonical(result);
    if (
      !hasExactKeys(result as unknown as Record<string, unknown>, RESULT_KEYS) ||
      !hasExactKeys(result.provenance as unknown as Record<string, unknown>, RESULT_PROVENANCE_KEYS) ||
      result.outcome !== item.expected.outcome ||
      result.safetyClass !== item.expected.safety_class ||
      result.riskArea !== item.expected.risk_area ||
      result.reasonCode !== item.expected.reason_code ||
      fallbackCode !== item.expected.fallback_code ||
      result.provenance.engine !== item.expected.provenance.engine ||
      result.provenance.signal !== item.expected.provenance.signal ||
      result.provenance.adjusted !== item.expected.provenance.adjusted ||
      (result.actionCode !== null && !item.expected.allowed_action_codes.includes(result.actionCode)) ||
      (result.actionCode === null && item.expected.allowed_action_codes.length > 0) ||
      item.expected.forbidden_output.some((term) => resultText.toLowerCase().includes(term.toLowerCase()))
    ) {
      failures.push(`${item.id}: expected ${JSON.stringify(item.expected)}, got ${JSON.stringify(result)}`);
    }
  }

  if (failures.length > 0) throw new Error(failures.join("\n"));
  process.stdout.write(`PASS ${golden.length} golden and ${adversarial.length} adversarial unique rule cases\n`);
}

void main();
