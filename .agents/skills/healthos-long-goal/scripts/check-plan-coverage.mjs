#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const statePath = resolve(process.argv[2] || "docs/goals/healthos-v1/state.yaml");
const source = readFileSync(statePath, "utf8").replace(/\r\n/g, "\n");
const taskBlocks = new Map();
const starts = [...source.matchAll(/^  - id:\s*(T\d{3})\s*$/gm)];

for (let index = 0; index < starts.length; index += 1) {
  const start = starts[index].index;
  const end = starts[index + 1]?.index ?? source.indexOf("\nchecks:", start);
  taskBlocks.set(starts[index][1], source.slice(start, end === -1 ? source.length : end));
}

const required = Array.from({ length: 28 }, (_, index) => `T${100 + index}`);
const errors = [];

for (const id of required) {
  const block = taskBlocks.get(id);
  if (!block) {
    errors.push(`${id} is missing from the board`);
    continue;
  }
  if (!/^    status:\s*done\s*$/m.test(block)) errors.push(`${id} is not done`);
  if (!/^      result:\s*done\s*$/m.test(block)) errors.push(`${id} lacks a done receipt`);
}

const report = {
  ok: errors.length === 0,
  state_path: statePath,
  required_tasks: required,
  errors,
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
