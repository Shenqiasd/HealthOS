# HealthOS V1.0 Production Release

## Objective

Build and release the complete production-grade HealthOS V1.0 iOS health companion defined by the existing technical design and implementation plan, progressing from governance gates through a reproducible TestFlight Beta and production-readiness evidence.

## Original Request

Implement the complete first version of HealthOS as a real product rather than a demo, and use a durable long-goal operating loop so Codex can continue correctly across long sessions and context compaction.

## Intake Summary

- Input shape: `existing_plan`
- Audience: HealthOS product, engineering, medical-review, operations, and release owners
- Authority: product owner approved entering implementation Task 0 on 2026-07-10 and, on 2026-07-14, approved continuing synthetic functional development without waiting for nonessential pre-Beta security hardening; named legal, privacy, medical, Apple, WeCom, provider, security, incident-response, backup, and release approvals remain separately required before their real-data, external-integration, Beta, or production boundaries
- Proof type: `test`, `artifact`, `metric`, `review`, and `decision`
- Completion proof: Task 27 release gates and the plan's Definition of Done pass with traceable receipts, including TestFlight, safety, privacy, security, performance, recovery, operations, rollback, and SLO evidence
- Goal oracle: the current executable release-gate suite and final Judge/PM evidence audit against the original V1 outcome
- Likely misfire: shipping a polished image-backed demo, a partial vertical slice, or an unsafe AI health adviser while declaring V1 complete
- Blind spots considered: legal and medical authority, Mainland China data and distribution constraints, HealthKit/App Store readiness, WeCom feasibility, reviewer capacity, provider handling, migration, rollback, and long-session state drift
- Existing plan facts: preserve `docs/plans/2026-07-10-healthos-v1-technical-design.md` and `docs/plans/2026-07-10-healthos-v1-implementation.md`; execute M0-M6 and Task 0-27 in dependency order; do not copy the prototype into production

## Goal Oracle

The oracle for this goal is:

`The release-gate suite and final evidence audit prove that Task 27, M6, and every Definition of Done item are satisfied by the implemented system, with reproducible TestFlight and production-readiness receipts.`

The PM must keep comparing task receipts to this oracle. Planning, discovery, a passing tiny slice, a visual prototype, or a clean-looking board is not enough. The goal finishes only when a final Judge/PM audit maps receipts and verification back to this oracle and records `full_outcome_complete: true`.

## Goal Kind

`existing_plan`

## Current Tranche

Continue the largest safe synthetic functional packages through the complete V1 workflow while keeping essential product safety inside each slice. Close external governance and pre-Beta hardening gates before real data, external providers, TestFlight Beta, infrastructure promotion, or production release, without inventing human approvals.

## Non-Negotiable Constraints

- `state.yaml` is the only task-status truth; the implementation plan is the scope and dependency truth.
- Exactly one task is active unless disjoint write scopes are explicitly proven on the board.
- Do not start downstream work before its applicable Task 0 decisions and listed dependencies are green.
- Never fabricate privacy, regulatory, medical, Apple, provider, security, or channel approval.
- Use synthetic health data unless a named internal user explicitly consented.
- Deterministic rules and safety policy own health decisions; LLM output is constrained explanation only.
- Do not copy `healthos-v1-ios-prototype/src/App.jsx` into the native product.
- Preserve user-authored and unrelated untracked files.
- Every task ends with verification, a narrow commit or identified diff, and a durable receipt.
- WeCom remains optional and ships only if its binary feasibility gate passes; personal-WeChat bridging remains outside V1.

## Security Scope And Development Continuity

The product owner's 2026-07-14 decision establishes two security tiers so release hardening does not become an unbounded prerequisite for functional development.

**Tier A: development-essential safety.** Every affected functional slice must implement and verify resource ownership, authentication/session boundaries, consent and deletion fences, deterministic health-decision rules, fixed emergency handling, provider-output validation, input and upload limits, privacy-safe logging, audit reconstruction, idempotency, feature flags, and kill switches. A reproducible Tier A failure blocks that slice.

**Tier B: pre-Beta and production hardening.** Named security-owner approval, final threat-model sign-off, offensive review or penetration testing, complete dependency/container/Terraform/supply-chain scanning, production network and KMS validation, incident tabletop exercises, and backup/restore RPO/RTO drills are outside the current functional-development critical path. They remain required in Tasks 24-27 before real-data Beta or production release.

Consequences:

- Missing Tier B evidence does not block local development with synthetic data through Tasks 1-23.
- Missing legal, medical, Apple, channel, or provider authority blocks only the slice that would use real data, real health advice, native entitlements, an external provider, or an external channel.
- A cyber-policy refusal from an optional attack-style subagent is recorded as deferred release evidence; it is not treated as a product-code failure when deterministic local tests and the affected functional acceptance gates pass.
- This sequencing change does not authorize real health data, remove Tasks 24-27, weaken Tier A checks, or permit HealthOS V1 completion before the final release audit.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete, or when an exact mandatory human decision is the only remaining blocker and no safe plan-permitted local work remains.

Do not stop after planning, discovery, Judge selection, or one successful Worker package. Advance to the next largest safe task unless a phase, risk, rejected-verification, ambiguity, human-approval, or final-completion boundary requires review.

If exact human approval is required but safe plan-permitted work remains, block only that task with a receipt and activate the next safe task. If it is the only remaining blocker, preserve the exact reply, mark every unfinished task blocked with receipts, set `waiting_for_user_approval: true`, set `goal.status: blocked`, and set `active_task: null`. Do not simulate approval.

## Slice Sizing

A good task is the largest safe useful slice that is bounded by explicit files, dependencies, verification, and stop conditions. Prefer complete vertical behavior over tiny scaffolding tasks. High-risk governance, health-decision, migration, privacy, and release work may use smaller slices when isolation materially improves safety.

## Board Health

The PM owns board health. Resume with:

```bash
bash .agents/skills/healthos-long-goal/scripts/goalbuddy.sh resume docs/goals/healthos-v1
```

If the board is stale or inconsistent, run the installed GoalBuddy checker and repair only GoalBuddy control files unless an active Worker or PM task explicitly allows product-file edits.

## Canonical Board

Machine truth lives at:

`docs/goals/healthos-v1/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status, active task, receipts, verification freshness, and completion truth.

## Run Command

```text
/goal Follow docs/goals/healthos-v1/goal.md.
```

## PM Loop

On every continuation:

1. Load `$healthos-long-goal` and the GoalBuddy execution contract.
2. Read this charter and `state.yaml`.
3. Reconcile the active task with Git and its latest receipt.
4. Work only on the active task and respect its authority, file scope, verification, and stop conditions.
5. Write a compact receipt and update the board.
6. Continue to the next largest safe task until a real boundary or the completion oracle is reached.
