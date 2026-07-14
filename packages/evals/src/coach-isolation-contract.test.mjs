import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

const packageRoot = new URL("../", import.meta.url);
const publicLauncher = fileURLToPath(new URL("../bin/eval-coach", import.meta.url));

test("Coach eval bootstrap installs isolation before dynamically importing application code", async () => {
  const bootstrap = await readFile(new URL("run-coach-evals.ts", import.meta.url), "utf8");
  assert.doesNotMatch(bootstrap, /apps\/api/);
  assert.match(bootstrap, /await import\(["']\.\/coach-eval-runner["']\)/);
});

test("Coach eval bootstrap fails closed when the OS and Node permission launcher is bypassed", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/run-coach-evals.ts"],
    { cwd: packageRoot, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0, `direct bootstrap unexpectedly passed:\n${result.stdout}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /isolation|permission|sandbox|denied/i);
});

test("Coach eval native environment launcher removes every preload variable before execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "healthos-eval-preload-"));
  const preload = join(directory, "preload.cjs");
  const shellPreload = join(directory, "shell-preload.sh");
  const fakeBin = join(directory, "bin");
  const fakeNode = join(fakeBin, "node");
  const marker = join(directory, "preload-ran");
  await writeFile(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`, "utf8");
  await writeFile(shellPreload, `printf ran > ${JSON.stringify(marker)}\n`, "utf8");
  await mkdir(fakeBin);
  await writeFile(fakeNode, `#!/bin/sh\nprintf fake-node > ${JSON.stringify(marker)}\n`, "utf8");
  await chmod(fakeNode, 0o755);
  try {
    const result = spawnSync(
      "/usr/bin/env",
      [
        "-u", "NODE_OPTIONS",
        "-u", "NODE_PATH",
        "-u", "BASH_ENV",
        "-u", "ENV",
        "-u", "DYLD_INSERT_LIBRARIES",
        "-u", "DYLD_LIBRARY_PATH",
        "HEALTHOS_COACH_EVAL_CLEAN_LAUNCH=env-v1",
        process.execPath,
        "src/run-coach-evals-isolated.mjs",
      ],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_OPTIONS: `--require=${preload}`,
          BASH_ENV: shellPreload,
          ENV: shellPreload,
          DYLD_INSERT_LIBRARIES: "/does/not/exist.dylib",
          DYLD_LIBRARY_PATH: directory,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      },
    );
    assert.equal(result.status, 0, `clean launcher failed:\n${result.stdout}\n${result.stderr}`);
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("public non-Node entry removes hostile preload and PATH values before any Node process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "healthos-eval-public-entry-"));
  const preload = join(directory, "preload.cjs");
  const shellPreload = join(directory, "shell-preload.sh");
  const fakeBin = join(directory, "bin");
  const fakeNode = join(fakeBin, "node");
  const marker = join(directory, "preload-ran");
  await writeFile(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "node-options");\n`, "utf8");
  await writeFile(shellPreload, `printf shell-preload > ${JSON.stringify(marker)}\n`, "utf8");
  await mkdir(fakeBin);
  await writeFile(fakeNode, `#!/bin/sh\nprintf fake-node > ${JSON.stringify(marker)}\n`, "utf8");
  await chmod(fakeNode, 0o755);
  try {
    const result = spawnSync(publicLauncher, [], {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HEALTHOS_NODE_EXECUTABLE: process.execPath,
        NODE_OPTIONS: `--require=${preload}`,
        NODE_PATH: directory,
        BASH_ENV: shellPreload,
        ENV: shellPreload,
        DYLD_INSERT_LIBRARIES: "/does/not/exist.dylib",
        DYLD_LIBRARY_PATH: directory,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        npm_node_execpath: fakeNode,
      },
    });
    assert.equal(result.status, 0, `public launcher failed:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /PASS coach_eval/);
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("parent preload cannot replace the trusted runtime and false-green without running Coach cases", () => {
  const pnpmCli = process.env.npm_execpath;
  assert.ok(pnpmCli, "pnpm CLI path is required for the parent-preload probe");
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [pnpmCli, "--filter", "@healthos/evals", "eval:coach"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: '--import=data:text/javascript,process.env.HEALTHOS_NODE_EXECUTABLE%3D%22%2Fusr%2Fbin%2Ftrue%22',
      },
    },
  );
  assert.equal(result.status, 0, `parent-preload probe failed:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PASS coach_eval cases=[1-9][0-9]* .*evaluation_attempted_egress_or_process=0/);
});

test("package command uses the native environment launcher instead of a shell preloader boundary", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["eval:coach"], "./bin/eval-coach");
});

test("direct Node launcher fails without the non-Node clean-launch boundary", () => {
  const result = spawnSync(
    process.execPath,
    ["src/run-coach-evals-isolated.mjs"],
    { cwd: packageRoot, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0, `direct launcher unexpectedly passed:\n${result.stdout}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /clean|launcher|isolation/i);
});
