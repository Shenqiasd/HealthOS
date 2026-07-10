# Contributing To HealthOS

## Before Editing

1. Resume the board with `bash .agents/skills/healthos-long-goal/scripts/goalbuddy.sh resume docs/goals/healthos-v1`.
2. Read the active task, its matching implementation-plan task, and the relevant technical-design section.
3. Confirm prerequisites, authority, `allowed_files`, verification, and stop conditions.
4. Preserve unrelated or user-authored work in the checkout.

## Branches And Pull Requests

- Use `codex/<goal-task>-<short-description>` for agent work.
- Keep one GoalBuddy Worker package per pull request.
- Do not push feature work directly to `main`.
- Do not combine scaffolding, refactors, and unrelated behavior in one pull request.
- Update diagrams, contracts, tests, runbooks, and migrations in the same pull request as the behavior they describe.

Every pull request must include:

- the GoalBuddy task ID;
- the outcome that became true;
- files and contracts changed;
- commands run and their results;
- safety, privacy, migration, rollback, and residual-risk notes when applicable;
- screenshots only as visual evidence, never as proof of workflow correctness.

## Verification

Run the active task's declared checks. At minimum, also run affected tests, lint, type checks, builds, migrations, accessibility checks, and security checks. A failing required command blocks the task and remains visible in its receipt.

## Health Data And AI Safety

- Use synthetic health data unless a named internal user explicitly consented.
- Do not put health payloads in logs, analytics, fixtures, screenshots, issues, or pull requests.
- Deterministic rules and safety policy own health decisions. LLMs may explain validated structured output but do not make independent medical decisions.
- Never fabricate legal, medical, privacy, Apple, provider, or release approval.

## Completion

A merged pull request is not automatically a completed GoalBuddy task. The PM records a receipt only after merge and verification evidence are available, then activates the next safe task.
