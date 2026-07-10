# HealthOS

HealthOS is a production-oriented native iOS health companion. V1 combines HealthKit data, confirmed lab facts, deterministic safety rules, Today, Coach, Map, Review, and privacy-aware delivery. The product is currently in preflight and foundation work; the image-backed web prototype is a design reference, not the production application.

## Source Of Truth

- Product and architecture: [`docs/plans/2026-07-10-healthos-v1-technical-design.md`](docs/plans/2026-07-10-healthos-v1-technical-design.md)
- Implementation scope and dependencies: [`docs/plans/2026-07-10-healthos-v1-implementation.md`](docs/plans/2026-07-10-healthos-v1-implementation.md)
- Long-goal charter: [`docs/goals/healthos-v1/goal.md`](docs/goals/healthos-v1/goal.md)
- Current task state and receipts: [`docs/goals/healthos-v1/state.yaml`](docs/goals/healthos-v1/state.yaml)
- Project execution skill: [`.agents/skills/healthos-long-goal/SKILL.md`](.agents/skills/healthos-long-goal/SKILL.md)

GoalBuddy's `state.yaml` is the only task-status truth. GitHub stores code, reviews, CI evidence, and release history; GitHub Issues must not become a duplicate task board.

## Resume Work

Every new or compacted Codex session begins with:

```bash
bash .agents/skills/healthos-long-goal/scripts/goalbuddy.sh resume docs/goals/healthos-v1
git status --short --branch
```

Native GoalBuddy execution uses:

```text
/goal Follow docs/goals/healthos-v1/goal.md.
```

## Repository Shape

```text
.agents/skills/healthos-long-goal/  Durable HealthOS execution contract
docs/goals/healthos-v1/             GoalBuddy charter, board, and receipts
docs/plans/                         Reviewed technical and implementation plans
healthos-v1-ios-prototype/          Image-backed visual reference prototype
apps/                               Production applications, created by the plan
packages/                           Shared contracts, rules, evals, and fixtures
infra/                              Deployment, observability, and runbooks
```

## Prototype

```bash
npm --prefix healthos-v1-ios-prototype ci
npm --prefix healthos-v1-ios-prototype run build
npm --prefix healthos-v1-ios-prototype run dev
```

The production iOS application will be native SwiftUI. Do not copy `healthos-v1-ios-prototype/src/App.jsx` into production code.

## Development Contract

1. Work only on the active GoalBuddy task.
2. Use a `codex/<task>-<slug>` branch for implementation work.
3. Keep one safe work package per pull request.
4. Run the task's full verification before requesting review.
5. Merge only after required GitHub checks pass.
6. Record the commit, pull request, CI run, and material evidence in the GoalBuddy receipt.
7. Never commit real health data, credentials, provider exports, or production logs.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SECURITY.md`](SECURITY.md) before making changes.
