#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", ".goalbuddy-board"]);

export function matchesPattern(file, pattern) {
  const normalizedFile = normalize(file);
  const normalizedPattern = normalize(pattern);
  if (!normalizedPattern) return false;
  if (normalizedFile === normalizedPattern) return true;
  const token = "__GLOBSTAR__";
  const source = escapeRegex(normalizedPattern)
    .replace(/\*\*/g, token)
    .replace(/\*/g, "[^/]*")
    .replace(new RegExp(token, "g"), ".*");
  return new RegExp(`^${source}$`).test(normalizedFile);
}

export function diffSnapshots(before, after) {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths]
    .filter((path) => before[path]?.hash !== after[path]?.hash || before[path]?.type !== after[path]?.type)
    .sort()
    .map((path) => ({
      path,
      change: !(path in before) ? "added" : !(path in after) ? "deleted" : "modified",
    }));
}

export function snapshot(root) {
  const result = {};
  walk(root, root, result);
  return result;
}

function walk(root, current, result) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const absolute = resolve(current, entry.name);
    const path = normalize(relative(root, absolute));
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      walk(root, absolute, result);
    } else if (stat.isSymbolicLink()) {
      result[path] = { type: "symlink", hash: sha256(readlinkSync(absolute)) };
    } else if (stat.isFile()) {
      result[path] = { type: "file", hash: sha256(readFileSync(absolute)), size: stat.size };
    }
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalize(value) {
  return String(value || "").split(sep).join("/").replace(/^\.\//, "").replace(/\/$/, "");
}

function escapeRegex(value) {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, output: "", baseline: "", root: "", allow: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--output") options.output = rest[++index] || "";
    else if (arg === "--baseline") options.baseline = rest[++index] || "";
    else if (arg === "--root") options.root = rest[++index] || "";
    else if (arg === "--allow") options.allow.push(rest[++index] || "");
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function repoRoot(explicitRoot) {
  if (explicitRoot) return resolve(explicitRoot);
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = repoRoot(options.root);

  if (options.command === "snapshot") {
    if (!options.output) throw new Error("snapshot requires --output <file>");
    const output = resolve(root, options.output);
    const payload = { version: 1, root, created_at: new Date().toISOString(), files: snapshot(root) };
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(JSON.stringify({ ok: true, output, files: Object.keys(payload.files).length }, null, 2));
    return;
  }

  if (options.command === "verify") {
    if (!options.baseline) throw new Error("verify requires --baseline <file>");
    const baseline = resolve(root, options.baseline);
    if (!existsSync(baseline)) throw new Error(`baseline not found: ${baseline}`);
    const before = JSON.parse(readFileSync(baseline, "utf8"));
    const changed = diffSnapshots(before.files || {}, snapshot(root));
    const violations = changed.filter(({ path }) => !options.allow.some((pattern) => matchesPattern(path, pattern)));
    const report = { ok: violations.length === 0, changed, violations, allowed: options.allow };
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    return;
  }

  throw new Error("Usage: scope-guard.mjs snapshot --output <file> | verify --baseline <file> [--allow <glob>]...");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
