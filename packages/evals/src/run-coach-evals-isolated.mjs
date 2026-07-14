import { constants, accessSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.env.HEALTHOS_COACH_EVAL_CLEAN_LAUNCH !== "env-v1" || process.env.NODE_OPTIONS?.trim()) {
  throw new Error("Coach eval isolation requires the clean non-Node launcher boundary");
}

if (process.platform !== "darwin") {
  throw new Error("Coach evals fail closed without an implemented OS deny-network sandbox");
}

const sandbox = "/usr/bin/sandbox-exec";
accessSync(sandbox, constants.X_OK);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(dirname(packageRoot));
const runtimeRequire = createRequire(import.meta.url);
const tsc = runtimeRequire.resolve("typescript/bin/tsc");
const buildDirectory = mkdtempSync(join(tmpdir(), "healthos-coach-eval-"));
const profile = "(version 1) (allow default) (deny network*)";
let exitCode = 1;
const childEnvironment = { ...process.env };
delete childEnvironment.NODE_OPTIONS;
delete childEnvironment.NODE_PATH;
delete childEnvironment.HEALTHOS_COACH_EVAL_CLEAN_LAUNCH;
delete childEnvironment.BASH_ENV;
delete childEnvironment.ENV;
delete childEnvironment.DYLD_INSERT_LIBRARIES;
delete childEnvironment.DYLD_LIBRARY_PATH;
try {
  const compile = spawnSync(
    process.execPath,
    [
      tsc,
      "--project",
      join(packageRoot, "tsconfig.json"),
      "--outDir",
      buildDirectory,
      "--declaration",
      "false",
      "--declarationMap",
      "false",
      "--sourceMap",
      "false",
    ],
    { cwd: repositoryRoot, env: childEnvironment, stdio: "inherit" },
  );
  if (compile.error) throw compile.error;
  if (compile.signal) throw new Error(`Coach eval compilation terminated by ${compile.signal}`);
  if (compile.status !== 0) throw new Error(`Coach eval compilation failed with status ${compile.status}`);

  const result = spawnSync(
    sandbox,
    [
      "-p",
      profile,
      process.execPath,
      "--permission",
      "--allow-fs-read=*",
      join(buildDirectory, "packages/evals/src/run-coach-evals.js"),
    ],
    {
      cwd: packageRoot,
      env: {
        ...childEnvironment,
        HEALTHOS_COACH_EVAL_SANDBOX: "macos-deny-network-v1",
        NODE_PATH: [
          join(repositoryRoot, "apps/api/node_modules"),
          join(repositoryRoot, "packages/evals/node_modules"),
          join(repositoryRoot, "node_modules"),
        ].join(delimiter),
      },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Coach eval sandbox terminated by ${result.signal}`);
  exitCode = result.status ?? 1;
} finally {
  rmSync(buildDirectory, { recursive: true, force: true });
}

process.exitCode = exitCode;
