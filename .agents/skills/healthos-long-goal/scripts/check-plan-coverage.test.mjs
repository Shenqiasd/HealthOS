import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("./check-plan-coverage.mjs", import.meta.url).pathname;

test("coverage gate fails when required implementation tasks are missing", () => {
  const root = mkdtempSync(join(tmpdir(), "healthos-coverage-"));
  const state = join(root, "state.yaml");
  writeFileSync(state, "tasks:\n  - id: T100\n    status: done\n    receipt:\n      result: done\nchecks:\n");
  const result = spawnSync(process.execPath, [script, state], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /T101 is missing/);
});
