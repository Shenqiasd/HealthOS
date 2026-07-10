import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  REQUIRED_ARTIFACTS,
  REQUIRED_GATES,
  checkPreflight,
} from "./check-preflight-gates.mjs";

async function createWorkspace({ gateStatus = "pending", omitArtifact } = {}) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "healthos-preflight-"));
  await mkdir(path.join(rootDir, "docs/product"), { recursive: true });
  await mkdir(path.join(rootDir, "spikes/wecom-synthetic"), { recursive: true });

  const artifacts = REQUIRED_ARTIFACTS.map((artifact) => ({
    ...artifact,
    status: "pending",
    evidence: [],
  }));

  for (const artifact of artifacts) {
    if (artifact.id === omitArtifact) continue;
    await mkdir(path.dirname(path.join(rootDir, artifact.path)), { recursive: true });
    await writeFile(path.join(rootDir, artifact.path), `# ${artifact.id}\n`, "utf8");
  }

  const gates = REQUIRED_GATES.map((gate) => ({
    id: gate.id,
    status: gateStatus,
    owner: gateStatus === "approved" ? `${gate.id} owner` : null,
    approver_role: gate.approver_role,
    decided_at: gateStatus === "approved" ? "2026-07-10" : null,
    evidence: gateStatus === "approved" ? [`evidence/${gate.id}`] : [],
    required_evidence: [`Required evidence for ${gate.id}`],
    blocks: ["real_user_release"],
  }));

  const manifest = {
    schema_version: 1,
    synthetic_only: true,
    artifacts,
    gates,
    wecom: {
      status: gateStatus,
      result: gateStatus === "approved" ? "pass" : "pending",
      evidence: gateStatus === "approved" ? ["evidence/wecom"] : [],
    },
  };

  await writeFile(
    path.join(rootDir, "docs/product/preflight-gates.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  await writeFile(
    path.join(rootDir, "spikes/wecom-synthetic/protocol.json"),
    `${JSON.stringify({
      schema_version: 1,
      synthetic_only: true,
      decision_rule: "all_required_scenarios_must_pass",
      scenarios: [
        "consumer_binding",
        "proactive_message",
        "callback_verification",
        "opt_out",
        "tenant_employee_change",
        "authenticated_deep_link",
        "wrong_recipient_isolation",
        "send_time_consent",
      ].map((id) => ({ id, required: true })),
    }, null, 2)}\n`,
    "utf8",
  );

  return { rootDir, manifest };
}

test("structure mode accepts complete pending evidence templates", async () => {
  const { rootDir } = await createWorkspace();
  const result = await checkPreflight({ rootDir, mode: "structure" });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("structure mode reports a missing required artifact", async () => {
  const { rootDir } = await createWorkspace({ omitArtifact: "threat_model" });
  const result = await checkPreflight({ rootDir, mode: "structure" });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /threat-model\.md/);
});

test("readiness remains blocked while professional decisions are pending", async () => {
  const { rootDir } = await createWorkspace();
  const result = await checkPreflight({ rootDir, mode: "readiness" });

  assert.equal(result.ok, false);
  assert.equal(result.blockers.length, REQUIRED_GATES.length + 1);
});

test("expect-blocked succeeds only when readiness is structurally valid and blocked", async () => {
  const pending = await createWorkspace();
  const approved = await createWorkspace({ gateStatus: "approved" });

  const blockedResult = await checkPreflight({
    rootDir: pending.rootDir,
    mode: "readiness",
    expectBlocked: true,
  });
  const readyResult = await checkPreflight({
    rootDir: approved.rootDir,
    mode: "readiness",
    expectBlocked: true,
  });

  assert.equal(blockedResult.ok, true);
  assert.equal(readyResult.ok, false);
  assert.match(readyResult.errors.join("\n"), /expected readiness to be blocked/i);
});

test("approved decisions require an owner, date, and evidence", async () => {
  const { rootDir, manifest } = await createWorkspace({ gateStatus: "approved" });
  manifest.gates[0].owner = null;
  manifest.gates[0].decided_at = null;
  manifest.gates[0].evidence = [];
  await writeFile(
    path.join(rootDir, "docs/product/preflight-gates.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  const result = await checkPreflight({ rootDir, mode: "structure" });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /owner/);
  assert.match(result.errors.join("\n"), /decided_at/);
  assert.match(result.errors.join("\n"), /evidence/);
});
