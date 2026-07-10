#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_DIRECTORIES = [
  "apps/api",
  "apps/worker",
  "apps/admin",
  "apps/ios",
  "packages/contracts",
  "packages/rules",
  "packages/evals",
  "packages/test-fixtures",
  "packages/observability",
];

export const REQUIRED_FILES = [
  "package.json",
  "pnpm-workspace.yaml",
  ".env.example",
  "docker-compose.yml",
  "infra/docker/postgres-init.sql",
  "infra/terraform/modules/foundation/main.tf",
  "infra/terraform/modules/foundation/variables.tf",
  "infra/terraform/modules/foundation/outputs.tf",
  "infra/terraform/environments/staging-synthetic/main.tf",
  ".github/workflows/ci.yml",
  "docs/adr/0001-modular-monolith.md",
  "docs/adr/0002-production-data-region.md",
];

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function validateExampleEnvironment(contents) {
  const errors = [];
  const allowedPlaceholder = /(change-me|replace-me|local-only|healthos[-_]?local|localhost|example)/i;
  const secretPattern = /(sk-(?:proj-)?[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{12,}|AKIA[A-Z0-9]{12,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/i;

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || !line.includes("=")) continue;
    const separator = line.indexOf("=");
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();

    if (key === "HEALTHOS_SYNTHETIC_ONLY" && value !== "true") {
      errors.push("HEALTHOS_SYNTHETIC_ONLY must be true in .env.example");
    }
    if (secretPattern.test(value)) errors.push(`${key} contains a production-looking secret`);
    if (/(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY)$/i.test(key) && value !== "" && !allowedPlaceholder.test(value)) {
      errors.push(`${key} must be empty or an obvious local placeholder`);
    }
  }
  return errors;
}

export async function checkWorkspace({ rootDir = process.cwd() } = {}) {
  const errors = [];
  for (const directory of REQUIRED_DIRECTORIES) {
    if (!(await exists(path.join(rootDir, directory)))) errors.push(`Missing directory: ${directory}`);
  }
  for (const file of REQUIRED_FILES) {
    if (!(await exists(path.join(rootDir, file)))) errors.push(`Missing file: ${file}`);
  }

  const envPath = path.join(rootDir, ".env.example");
  if (await exists(envPath)) {
    errors.push(...validateExampleEnvironment(await readFile(envPath, "utf8")));
  }

  return { ok: errors.length === 0, errors };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = await checkWorkspace();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
