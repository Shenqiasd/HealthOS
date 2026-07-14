---
name: healthos-long-goal
description: Use when starting, resuming, implementing, reviewing, recovering, or handing off HealthOS V1 work across sessions, agents, worktrees, or context compaction.
---

# HealthOS Long Goal

## Purpose

Run HealthOS V1 as one durable GoalBuddy goal. Chat history is context, never project truth. Resume from the board, execute one bounded task, leave a receipt, and keep the board aligned with verified repository state.

## Canonical Files

Resolve the repository root with `git rev-parse --show-toplevel`, then use:

- Goal charter: `docs/goals/healthos-v1/goal.md`
- Board truth: `docs/goals/healthos-v1/state.yaml`
- Implementation plan: `docs/plans/2026-07-10-healthos-v1-implementation.md`
- Technical design: `docs/plans/2026-07-10-healthos-v1-technical-design.md`
- Design plan: `HEALTHOS_V1_IOS_DESIGN_PLAN.md`
- Visual prototype: `healthos-v1-ios-prototype/` is reference material, not production source.

If task status differs anywhere, `state.yaml` wins. The implementation plan owns scope and dependencies; the board owns current execution state and receipts. Do not maintain a second task-status list in another document.

## Mandatory Resume Sequence

Run this sequence at the start of every session, after compaction, after handoff, and before claiming a task is complete:

```bash
git rev-parse --show-toplevel
bash .agents/skills/healthos-long-goal/scripts/goalbuddy.sh resume docs/goals/healthos-v1
git status --short --branch
```

Then:

1. Read `goal.md` and all top-level board fields in `state.yaml`.
2. Read only the active task plus receipts and dependencies it names.
3. Read the matching task in the implementation plan and the relevant technical-design section.
4. Inspect current Git changes before editing. Preserve user work and unrelated untracked files.
5. Confirm the active task's authority. For a Worker, also confirm `allowed_files`, `verify`, and `stop_if` are executable.
6. Continue the active task. Do not silently select a different task.

If there is no active task, the board is inconsistent, or Git evidence conflicts with the receipt, create or activate a read-only PM/Judge recovery task before implementation.

## GoalBuddy Contract

- Read the installed GoalBuddy `goal-prep/references/goal-execution.md` at the start of a native `/goal` run.
- Exactly one task is active unless the board explicitly proves disjoint write scopes.
- Scout and Judge are read-only.
- Worker edits only `allowed_files` and runs every `verify` command.
- PM owns `state.yaml`, activates the next task, and records receipts.
- Every done, blocked, or escalated task requires a compact receipt with evidence.
- Review at phase, risk, rejected-verification, ambiguity, and final boundaries. Do not add review theater after every tiny edit.
- Finish only when a final Judge or PM audit records `full_outcome_complete: true` against the oracle.

Use GoalBuddy's receipt command when possible:

```bash
bash .agents/skills/healthos-long-goal/scripts/goalbuddy.sh receipt docs/goals/healthos-v1 \
  --task T### --receipt /absolute/path/to/receipt.json \
  --status done --activate T###
```

Receipt input is JSON, not YAML. While the goal is active, always pass the next task with `--activate`; omitting it clears `active_task` and makes the active board invalid. Use `--activate none` only as part of a valid terminal transition where PM also sets the goal and all task states consistently.

Do not hand-edit task status without also preserving the evidence that justifies the transition.

Use `scripts/goalbuddy.sh` for every GoalBuddy CLI operation, including `doctor`, `dispatch`, `board`, and `parallel-plan`. The wrapper avoids the stale Bun `codex` shim in this machine's shell and prefers the working Codex CLI bundled with the desktop app without changing global PATH.

## Scope Guard

This repository currently has no baseline commit, so GoalBuddy's Git filename delta cannot detect edits to files that were already untracked before a task began. Until a trustworthy HEAD exists, the hash scope guard is mandatory for every delegated or local task.

Before work:

```bash
node .agents/skills/healthos-long-goal/scripts/scope-guard.mjs snapshot \
  --output docs/goals/healthos-v1/.goalbuddy-board/scopes/T###.json
```

After work and before recording the receipt:

```bash
node .agents/skills/healthos-long-goal/scripts/scope-guard.mjs verify \
  --baseline docs/goals/healthos-v1/.goalbuddy-board/scopes/T###.json \
  --allow 'path/from/allowed_files/**'
```

- Scout and Judge pass no `--allow` values and must produce no repository changes.
- Worker passes every board `allowed_files` pattern exactly.
- PM may pass `--allow 'docs/goals/healthos-v1/**'` for board maintenance only.
- A scope violation blocks the task. Inspect and preserve user work; never delete an out-of-scope change merely to make the guard pass.

## HealthOS Safety Gates And Sequencing

The implementation plan is an existing approved engineering plan, not permission to fabricate non-technical approvals.

Task 0 must truthfully record the applicable decisions and named owners for:

- privacy, data region, retention, and regulatory positioning;
- medical-content and clinical governance;
- Apple Developer, HealthKit, App Store, and TestFlight readiness;
- enterprise messaging and the binary WeCom feasibility result;
- incident response, backups, providers, and threat model.

Never invent legal, medical, platform, provider, or owner sign-off. Apply the product owner's 2026-07-14 two-tier decision:

- **Development-essential safety** remains mandatory in each affected slice: ownership/authorization, consent/deletion fences, deterministic health rules, fixed emergency paths, provider-output validation, bounded inputs/uploads, privacy-safe logs, auditability, idempotency, feature flags, and kill switches. A reproducible failure blocks that slice.
- **Pre-Beta hardening** does not block synthetic local Tasks 1-23: final security/threat-model sign-off, attack-style independent review, penetration testing, complete supply-chain/container/Terraform scans, production network/KMS validation, incident exercises, and backup/restore RPO/RTO evidence. Keep these pending for Tasks 24-27.
- Missing external authority blocks only work that crosses into real data, real providers/channels, Apple entitlements/distribution, infrastructure promotion, TestFlight Beta, or production release. Continue independent synthetic work.
- If an optional cyber-focused subagent is refused by platform policy, record the refusal as deferred release evidence and use deterministic local acceptance gates for the current functional slice; do not repeatedly resubmit the same attack-style prompt.

Additional invariants:

- Use synthetic health data unless a named internal user explicitly consented.
- Deterministic rules and safety policy own health decisions; an LLM may only explain or rephrase validated structured output.
- Do not copy `healthos-v1-ios-prototype/src/App.jsx` into the production app.
- A screenshot proves visual fidelity only, never workflow correctness.
- No personal-WeChat bridge enters V1. Use WeCom only after its gate passes; otherwise use APNs and in-app Coach.
- Do not send health payloads to third-party analytics or expose them in logs.

## Task Execution Loop

For the active task:

1. **Orient**: restate the task objective, dependencies, scope, verification, and stop conditions from durable files.
2. **Validate**: confirm prerequisites are green on `main`; do not bypass Task 0 or listed dependencies.
3. **Implement**: use test-first development for domain behavior, contracts, state machines, safety rules, and data access.
4. **Verify**: run task-specific tests plus affected lint, typecheck, build, accessibility, visual, security, or migration checks.
5. **Inspect**: compare the diff to `allowed_files`; remove no user-authored or unrelated changes.
6. **Receipt**: record commands, results, commit or diff identity, decisions, residual risks, and the exact next task.
7. **Advance**: PM activates the next largest safe task from the plan. Do not stop merely because one package passed.

Commit only the active task's declared scope. A failed verification remains visible in the receipt; never convert a partial pass into `done`.

## Receipt Minimum

Worker receipt input must use GoalBuddy's real JSON contract:

```json
{
  "result": "done",
  "changed_files": ["path/to/file"],
  "commands": [
    {"cmd": "command that ran", "status": "pass"}
  ],
  "summary": "What became true",
  "evidence": ["artifact or result"],
  "risks_remaining": [],
  "next": "Exact next task or required human input"
}
```

Blocked receipts use `"result": "blocked"`, keep failing command statuses visible, and include `blocked_reason`. Judge receipts require `result`, `decision`, `full_outcome_complete`, and `rationale`; Scout receipts require `result`, `summary`, and `evidence` or `note`. Do not rename GoalBuddy fields.

For health-affecting behavior, include the golden-case or safety-eval result. For UI, include accessibility and visual-regression evidence. For infrastructure or release work, include environment, version, rollback, and live/staging proof.

## Compaction And Recovery Rules

After context compaction:

- Treat the summary as a hint only.
- Re-run the mandatory resume sequence.
- Re-read the active task, current diff, and latest receipt.
- Re-run the last cheap verification before editing when repository state may have changed.
- Do not repeat completed work solely because the chat no longer contains it.
- Do not mark work complete solely because the summary says it passed.

When blocked, preserve the exact failing command, error, attempted fixes, and required unblocking event in the receipt. A later session must be able to resume without reconstructing the failure from conversation history.

## Completion Oracle

HealthOS V1 is not complete when the four screens look polished or when a demo runs. Completion requires the implementation plan's Task 27 release gates and Definition of Done, including receipt-backed functional, safety, privacy, security, performance, recovery, migration, operational, TestFlight, and SLO evidence.

Before final completion, run the mechanical plan-coverage gate:

```bash
node .agents/skills/healthos-long-goal/scripts/check-plan-coverage.mjs
```

It must confirm that board tasks T100-T127, corresponding to implementation Tasks 0-27, all have `done` receipts. A blocked, missing, or merely absent plan task prevents completion.

The final Judge or PM audit must map that evidence to the original V1 outcome and explicitly record:

```yaml
full_outcome_complete: true
```
