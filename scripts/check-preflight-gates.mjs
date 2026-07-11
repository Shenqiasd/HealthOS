#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_ARTIFACTS = [
  { id: "data_inventory", path: "docs/product/data-inventory.md" },
  { id: "data_flow", path: "docs/product/data-flow.md" },
  { id: "privacy_impact", path: "docs/product/privacy-impact-assessment.md" },
  { id: "retention_schedule", path: "docs/product/retention-schedule.md" },
  { id: "regulatory_positioning", path: "docs/product/regulatory-positioning.md" },
  { id: "clinical_governance", path: "docs/product/clinical-governance.md" },
  { id: "apple_platform", path: "docs/product/apple-platform-readiness.md" },
  { id: "wecom_feasibility", path: "docs/product/wecom-feasibility.md" },
  { id: "provider_register", path: "docs/product/provider-register.md" },
  { id: "metrics_contract", path: "docs/product/metrics-contract.md" },
  { id: "threat_model", path: "docs/product/threat-model.md" },
  { id: "wecom_protocol", path: "spikes/wecom-synthetic/protocol.json" },
];

export const REQUIRED_GATES = [
  { id: "product_owner_authority", approver_role: "Product owner" },
  { id: "production_data_region", approver_role: "Legal/privacy owner" },
  { id: "privacy_legal_review", approver_role: "Legal/privacy owner" },
  { id: "regulatory_positioning", approver_role: "Legal/regulatory owner" },
  { id: "clinical_governance", approver_role: "Medical reviewer" },
  { id: "apple_platform_readiness", approver_role: "Apple release owner" },
  { id: "enterprise_messaging", approver_role: "WeCom administrator" },
  { id: "provider_governance", approver_role: "Privacy/security owner" },
  { id: "metrics_contract", approver_role: "Product and privacy owners" },
  { id: "threat_model", approver_role: "Security owner" },
  { id: "incident_response", approver_role: "Incident-response owner" },
  { id: "backup_recovery", approver_role: "Infrastructure owner" },
];

const VALID_STATUSES = new Set(["pending", "approved", "rejected"]);
const REQUIRED_WECOM_SCENARIOS = new Set([
  "consumer_binding",
  "proactive_message",
  "callback_verification",
  "opt_out",
  "tenant_employee_change",
  "authenticated_deep_link",
  "wrong_recipient_isolation",
  "send_time_consent",
]);

async function readJson(filePath, errors) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    errors.push(`${path.relative(process.cwd(), filePath)}: ${error.message}`);
    return null;
  }
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function validateDecision(decision, expected, errors) {
  const label = `gate ${expected.id}`;
  if (!decision) {
    errors.push(`${label} is missing`);
    return;
  }
  if (!VALID_STATUSES.has(decision.status)) {
    errors.push(`${label}.status must be pending, approved, or rejected`);
  }
  if (decision.approver_role !== expected.approver_role) {
    errors.push(`${label}.approver_role must be ${expected.approver_role}`);
  }
  if (!Array.isArray(decision.evidence)) {
    errors.push(`${label}.evidence must be an array`);
  }
  if (!Array.isArray(decision.required_evidence) || decision.required_evidence.length === 0) {
    errors.push(`${label}.required_evidence must describe the approval proof`);
  }
  if (!Array.isArray(decision.blocks) || decision.blocks.length === 0) {
    errors.push(`${label}.blocks must name the behavior held behind this gate`);
  }

  if (decision.status === "approved" || decision.status === "rejected") {
    if (typeof decision.owner !== "string" || decision.owner.trim() === "") {
      errors.push(`${label}.owner is required for a decided gate`);
    }
    if (typeof decision.decided_at !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(decision.decided_at)) {
      errors.push(`${label}.decided_at is required for a decided gate`);
    }
    if (!Array.isArray(decision.evidence) || decision.evidence.length === 0) {
      errors.push(`${label}.evidence is required for a decided gate`);
    }
  }
}

async function validateStructure(rootDir) {
  const errors = [];
  const manifestPath = path.join(rootDir, "docs/product/preflight-gates.json");
  const manifest = await readJson(manifestPath, errors);
  if (!manifest) return { errors, manifest: null };

  if (manifest.schema_version !== 1) errors.push("preflight-gates.json schema_version must be 1");
  if (manifest.synthetic_only !== true) errors.push("preflight-gates.json must remain synthetic_only");
  if (!Array.isArray(manifest.artifacts)) errors.push("preflight-gates.json artifacts must be an array");
  if (!Array.isArray(manifest.gates)) errors.push("preflight-gates.json gates must be an array");

  const artifacts = new Map((manifest.artifacts ?? []).map((item) => [item.id, item]));
  for (const expected of REQUIRED_ARTIFACTS) {
    const artifact = artifacts.get(expected.id);
    if (!artifact) {
      errors.push(`artifact ${expected.id} is missing from preflight-gates.json`);
      continue;
    }
    if (artifact.path !== expected.path) errors.push(`artifact ${expected.id}.path must be ${expected.path}`);
    if (!VALID_STATUSES.has(artifact.status)) {
      errors.push(`artifact ${expected.id}.status must be pending, approved, or rejected`);
    }
    if (!Array.isArray(artifact.evidence)) errors.push(`artifact ${expected.id}.evidence must be an array`);
    if (!(await exists(path.join(rootDir, expected.path)))) errors.push(`${expected.path} is missing`);
  }

  const gates = new Map((manifest.gates ?? []).map((item) => [item.id, item]));
  for (const expected of REQUIRED_GATES) validateDecision(gates.get(expected.id), expected, errors);

  const wecom = manifest.wecom;
  if (!wecom || !VALID_STATUSES.has(wecom.status)) {
    errors.push("wecom.status must be pending, approved, or rejected");
  } else {
    const expectedResult = { pending: "pending", approved: "pass", rejected: "fail" }[wecom.status];
    if (wecom.result !== expectedResult) errors.push(`wecom.result must be ${expectedResult} when status is ${wecom.status}`);
    if (!Array.isArray(wecom.evidence)) errors.push("wecom.evidence must be an array");
    if (wecom.status !== "pending" && wecom.evidence.length === 0) {
      errors.push("wecom.evidence is required for a PASS or FAIL decision");
    }
  }

  const protocolPath = path.join(rootDir, "spikes/wecom-synthetic/protocol.json");
  const protocol = await readJson(protocolPath, errors);
  if (protocol) {
    if (protocol.schema_version !== 1) errors.push("WeCom protocol schema_version must be 1");
    if (protocol.synthetic_only !== true) errors.push("WeCom protocol must be synthetic_only");
    if (protocol.decision_rule !== "all_required_scenarios_must_pass") {
      errors.push("WeCom protocol decision_rule must be all_required_scenarios_must_pass");
    }
    const scenarios = new Map((protocol.scenarios ?? []).map((item) => [item.id, item]));
    for (const id of REQUIRED_WECOM_SCENARIOS) {
      if (!scenarios.has(id) || scenarios.get(id).required !== true) {
        errors.push(`WeCom protocol requires scenario ${id}`);
      }
    }
  }

  return { errors, manifest };
}

export async function checkPreflight({ rootDir = process.cwd(), mode = "readiness", expectBlocked = false } = {}) {
  if (!new Set(["structure", "readiness"]).has(mode)) {
    return { ok: false, mode, errors: [`Unknown mode: ${mode}`], blockers: [] };
  }

  const { errors, manifest } = await validateStructure(rootDir);
  if (errors.length > 0 || mode === "structure") {
    return { ok: errors.length === 0, mode, errors, blockers: [] };
  }

  const blockers = manifest.gates
    .filter((gate) => gate.status !== "approved")
    .map((gate) => `${gate.id}:${gate.status}`);
  if (manifest.wecom.status !== "approved" || manifest.wecom.result !== "pass") {
    blockers.push(`wecom:${manifest.wecom.status}/${manifest.wecom.result}`);
  }

  if (expectBlocked) {
    if (blockers.length === 0) {
      return {
        ok: false,
        mode,
        errors: ["Expected readiness to be blocked, but every gate is approved"],
        blockers,
      };
    }
    return { ok: true, mode, errors: [], blockers, expected_blocked: true };
  }

  return {
    ok: blockers.length === 0,
    mode,
    errors: blockers.length === 0 ? [] : ["Production readiness is blocked"],
    blockers,
  };
}

function parseArgs(argv) {
  let mode = "readiness";
  let expectBlocked = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--mode") mode = argv[index + 1];
    if (argv[index] === "--expect-blocked") expectBlocked = true;
  }
  return { mode, expectBlocked };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = await checkPreflight({ rootDir: process.cwd(), ...parseArgs(process.argv.slice(2)) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
