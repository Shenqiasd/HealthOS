import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  REQUIRED_DIRECTORIES,
  REQUIRED_FILES,
  checkWorkspace,
} from "./check-workspace.mjs";

async function createWorkspace() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "healthos-workspace-"));
  for (const directory of REQUIRED_DIRECTORIES) {
    await mkdir(path.join(rootDir, directory), { recursive: true });
  }
  for (const file of REQUIRED_FILES) {
    await mkdir(path.dirname(path.join(rootDir, file)), { recursive: true });
    await writeFile(path.join(rootDir, file), `${file}\n`, "utf8");
  }
  await writeFile(
    path.join(rootDir, ".env.example"),
    "DATABASE_URL=postgresql://healthos:change-me-local-only@localhost:5432/healthos\nOBJECT_STORAGE_SECRET_KEY=change-me-local-only\n",
    "utf8",
  );
  return rootDir;
}

test("accepts the complete synthetic workspace shape", async () => {
  const rootDir = await createWorkspace();
  const result = await checkWorkspace({ rootDir });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("reports a missing module boundary", async () => {
  const rootDir = await createWorkspace();
  await rm(path.join(rootDir, "apps/worker"), { recursive: true });
  const result = await checkWorkspace({ rootDir });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /apps\/worker/);
});

test("rejects production-looking secrets from the example environment", async () => {
  const rootDir = await createWorkspace();
  const productionLookingApiKey = ["sk", "proj", "this-must-never-be-committed"].join("-");
  await writeFile(
    path.join(rootDir, ".env.example"),
    `OPENAI_API_KEY=${productionLookingApiKey}\n`,
    "utf8",
  );
  const result = await checkWorkspace({ rootDir });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /OPENAI_API_KEY/);
});

test("rejects an example environment that enables real data", async () => {
  const rootDir = await createWorkspace();
  await writeFile(
    path.join(rootDir, ".env.example"),
    "HEALTHOS_SYNTHETIC_ONLY=false\n",
    "utf8",
  );
  const result = await checkWorkspace({ rootDir });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /HEALTHOS_SYNTHETIC_ONLY/);
});
