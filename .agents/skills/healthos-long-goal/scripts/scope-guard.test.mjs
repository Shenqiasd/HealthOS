import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { diffSnapshots, matchesPattern } from "./scope-guard.mjs";

const script = new URL("./scope-guard.mjs", import.meta.url).pathname;

test("directory glob matches descendants but not sibling paths", () => {
  assert.equal(matchesPattern("docs/product/data.md", "docs/product/**"), true);
  assert.equal(matchesPattern("docs/products/data.md", "docs/product/**"), false);
});

test("snapshot diff reports modifications to an existing untracked file", () => {
  const changed = diffSnapshots(
    { "existing.txt": { type: "file", hash: "before" } },
    { "existing.txt": { type: "file", hash: "after" } },
  );
  assert.deepEqual(changed, [{ path: "existing.txt", change: "modified" }]);
});

test("CLI blocks an out-of-scope edit to an existing file", () => {
  const root = mkdtempSync(join(tmpdir(), "healthos-scope-"));
  mkdirSync(join(root, ".goalbuddy-board"), { recursive: true });
  writeFileSync(join(root, "existing.txt"), "before\n");
  execFileSync(process.execPath, [script, "snapshot", "--root", root, "--output", ".goalbuddy-board/baseline.json"]);
  writeFileSync(join(root, "existing.txt"), "after\n");

  const blocked = spawnSync(process.execPath, [script, "verify", "--root", root, "--baseline", ".goalbuddy-board/baseline.json"], { encoding: "utf8" });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /existing\.txt/);

  const allowed = spawnSync(process.execPath, [script, "verify", "--root", root, "--baseline", ".goalbuddy-board/baseline.json", "--allow", "existing.txt"], { encoding: "utf8" });
  assert.equal(allowed.status, 0);
});
