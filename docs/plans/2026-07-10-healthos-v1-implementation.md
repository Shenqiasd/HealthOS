# HealthOS V1.0 Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a production-grade HealthOS V1.0 iOS health companion with real HealthKit ingestion, confirmed lab data, Today/Coach/Map/Review, safe recommendations, weekly reports, official WeCom delivery only if its feasibility gate passes, operations tooling, observability, and a staged TestFlight release.

**Architecture:** Build a modular monolith with one TypeScript API, one worker process, PostgreSQL as the source of truth and durable job/outbox store, S3-compatible object storage for reports, a native SwiftUI iOS app, and a Next.js operations console. Deterministic rules and safety policy own health decisions; LLMs only explain or rephrase within a validated structured contract. The system stores the exact payload that was shown or sent and can deterministically replay the rule decision from canonical inputs; it does not promise deterministic regeneration from an external LLM.

**Tech Stack:** Swift/SwiftUI/HealthKit/SwiftData, TypeScript/NestJS/Fastify, PostgreSQL/Prisma with transactional outbox/inbox workers, Next.js, OpenAPI, Jest, Playwright, XCTest/XCUITest, Docker, Terraform, GitHub Actions, OpenTelemetry.

---

## 0. Execution Rules

1. Read `docs/plans/2026-07-10-healthos-v1-technical-design.md` before Task 0.
2. Do not copy `healthos-v1-ios-prototype/src/App.jsx` into the product. It is an image-backed design preview.
3. Preserve existing untracked files. Each task stages only files it owns.
4. Use test-first steps for domain behavior, API contracts, state machines, safety rules, and data access.
5. Every task ends with tests and a small commit. Do not combine structural scaffolding and unrelated feature behavior in one commit.
6. Use synthetic health data in local/CI/staging unless a named internal user has explicitly consented.
7. Do not start a downstream task until its listed dependencies are green on `main`.
8. A visual screenshot is evidence for design fidelity, never evidence that the underlying workflow works.

## 1. Target Repository Layout

```text
HealthOS/
├── apps/
│   ├── api/                    # NestJS HTTP API
│   ├── worker/                 # PostgreSQL outbox/inbox lease workers
│   ├── admin/                  # Next.js operations console
│   └── ios/                    # Native Xcode project
├── packages/
│   ├── contracts/              # OpenAPI schema and generated TS types
│   ├── rules/                  # Deterministic health rules and safety policy
│   ├── evals/                  # Golden cases and LLM safety evals
│   ├── test-fixtures/          # Synthetic profiles, HealthKit and lab fixtures
│   └── observability/          # Shared correlation/logging contracts
├── e2e/                        # Cross-system journeys
├── infra/
│   ├── docker/
│   ├── terraform/
│   └── runbooks/
├── docs/
│   ├── adr/
│   ├── api/
│   ├── product/
│   └── plans/
├── .github/workflows/
├── docker-compose.yml
├── pnpm-workspace.yaml
└── package.json
```

## 2. Milestone Map

| Milestone | Tasks | Exit condition |
|---|---|---|
| M0 Governance + Foundation | 0-6 | Data/compliance/channel/Apple gates plus CI, identity, consent, OpenAPI and iOS shell work |
| M1 Data Vertical Slice | 7-10 | Real HealthKit and confirmed lab facts reach a versioned profile snapshot |
| M2 Daily Advisor | 11-15 | Rules, safety, recommendation, Today, action feedback and Coach form a closed loop |
| M3 Complete V1 | 16-21 | Map, Food Risk Scan, Review, channels and admin are functional |
| M4 Hardening | 22-25 | Privacy, observability, E2E, security, performance and recovery gates pass |
| M5 Alpha | 26-27 | Staging and 5-person 14-day TestFlight Alpha are reproducible |
| M6 Beta/Production | 27 | 20-50-person Beta, remediation and four-week SLO evidence complete |

## 3. Task Plan

### Task 0: Close governance, platform, and feasibility gates

**Files:**

- Create: `docs/product/data-inventory.md`
- Create: `docs/product/data-flow.md`
- Create: `docs/product/privacy-impact-assessment.md`
- Create: `docs/product/retention-schedule.md`
- Create: `docs/product/regulatory-positioning.md`
- Create: `docs/product/clinical-governance.md`
- Create: `docs/product/apple-platform-readiness.md`
- Create: `docs/product/wecom-feasibility.md`
- Create: `docs/product/provider-register.md`
- Create: `docs/product/metrics-contract.md`
- Create: `docs/product/threat-model.md`
- Create: `spikes/wecom-synthetic/*`
- Test: `scripts/check-preflight-gates.mjs`

**Step 1: Write the failing preflight check**

Require named owners and signed decisions for data region, privacy/legal review, medical content, Apple Developer/App Store, enterprise messaging, incident response and backups. Require every external processor to have purpose, fields, region, retention, subprocessors, training-use policy and kill-switch behavior.

**Step 2: Run it and verify failure**

Run: `node scripts/check-preflight-gates.mjs`  
Expected: FAIL for every missing decision or owner.

**Step 3: Complete the architecture inputs**

Use qualified legal/privacy and medical reviewers for the decisions that require them. Record medical-device/health-service positioning, generative-AI obligations, MLPS/ICP/Mainland distribution implications, HealthKit/App Store restrictions, and the first retention schedule. Configure the product as not monitored in real time and define fixed emergency copy.

Build a synthetic-data WeCom spike for the exact target identity model. Verify whether arbitrary consumers can be bound, proactively messaged, receive callbacks, opt out, survive employee/tenant changes, and open an authenticated app deep link. The result is binary:

- PASS: WeCom remains an optional V1 Beta adapter.
- FAIL: V1 ships with APNs + in-app Coach only; personal-WeChat bridging remains isolated research.

**Step 4: Verify**

Run: `node scripts/check-preflight-gates.mjs`  
Expected: PASS.

Confirm Apple entitlements, signing, privacy manifest, required-reason APIs, App Privacy answers, in-app deletion, export compliance and external TestFlight requirements are represented before SDK/provider selection.

**Step 5: Commit**

```bash
git add docs/product spikes/wecom-synthetic scripts/check-preflight-gates.mjs
git commit -m "docs: close HealthOS V1 preflight gates"
```

### Task 1: Establish the repository baseline

**Files:**

- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `.gitignore`
- Create: `.editorconfig`
- Create: `.env.example`
- Create: `docker-compose.yml`
- Create: `infra/docker/postgres-init.sql`
- Create: `infra/terraform/modules/foundation/*`
- Create: `infra/terraform/environments/staging-synthetic/*`
- Create: `.github/workflows/ci.yml`
- Create: `docs/adr/0001-modular-monolith.md`
- Create: `docs/adr/0002-production-data-region.md`
- Test: `scripts/check-workspace.mjs`

**Step 1: Write the failing workspace check**

The script must assert that `apps/api`, `apps/worker`, `apps/admin`, `apps/ios`, `packages/contracts`, `packages/rules`, and `packages/evals` exist, that no production secret is present in `.env.example`, and that the synthetic staging foundation has encryption, private database networking, KMS/secret-manager placeholders and backup policy checks.

**Step 2: Run it and verify failure**

Run: `node scripts/check-workspace.mjs`  
Expected: FAIL with the first missing workspace path.

**Step 3: Add the minimal workspace and local services**

Create the directories with placeholder README files, configure pnpm workspaces, and add PostgreSQL plus an S3-compatible local object store to Docker Compose. Establish CI and a minimal production-like synthetic staging foundation now, so identity, storage, logging and network assumptions are tested before feature work. The two ADRs must record modular-monolith and production-region defaults plus reversal criteria from Task 0.

**Step 4: Verify**

Run: `docker compose config`  
Expected: valid configuration.

Run: `terraform fmt -check -recursive infra/terraform && terraform -chdir=infra/terraform/environments/staging-synthetic validate`  
Expected: PASS.

Run: `node scripts/check-workspace.mjs`  
Expected: PASS.

**Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml .gitignore .editorconfig .env.example docker-compose.yml infra scripts docs/adr .github/workflows/ci.yml
git commit -m "chore: establish HealthOS workspace"
```

### Task 2: Scaffold API, worker, admin, and shared contracts

**Files:**

- Create: `apps/api/src/main.ts`
- Create: `apps/api/src/app.module.ts`
- Create: `apps/api/src/health.controller.ts`
- Create: `apps/api/test/health.e2e-spec.ts`
- Create: `apps/worker/src/main.ts`
- Create: `apps/worker/src/worker.module.ts`
- Create: `apps/admin/app/page.tsx`
- Create: `packages/contracts/openapi/healthos-v1.yaml`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/observability/src/correlation.ts`
- Create: `packages/observability/src/correlation.spec.ts`

**Step 1: Write failing smoke and correlation tests**

Assert that `GET /health/live` returns `{ "status": "ok" }`, `GET /health/ready` reports database, object storage and worker lease health separately, and an incoming `x-correlation-id` is echoed or generated when absent.

**Step 2: Run and verify failure**

Run: `pnpm --filter api test:e2e -- health.e2e-spec.ts`  
Expected: FAIL because the app is not bootstrapped.

Run: `pnpm --filter observability test`  
Expected: FAIL because correlation helpers do not exist.

**Step 3: Implement the minimum skeleton**

Use NestJS with the Fastify adapter, global request validation, a consistent error envelope, redacted structured logging, graceful shutdown, and separate liveness/readiness checks. The worker must boot without registering feature jobs yet. The admin page must show only an environment badge and API readiness.

**Step 4: Verify**

Run: `pnpm lint && pnpm typecheck && pnpm test`  
Expected: PASS.

Run: `pnpm --filter api test:e2e`  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api apps/worker apps/admin packages/contracts packages/observability
git commit -m "feat: scaffold HealthOS services and API contract"
```

### Task 3: Create the production database schema and migration discipline

**Files:**

- Create: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/*/migration.sql`
- Create: `apps/api/src/database/database.module.ts`
- Create: `apps/api/src/database/prisma.service.ts`
- Create: `apps/api/test/database-constraints.e2e-spec.ts`
- Create: `infra/runbooks/database-migration.md`

**Step 1: Write failing constraint tests**

Cover these invariants:

- One active primary action per user and local date.
- One outbox idempotency key globally.
- Recommendation snapshots are immutable; a correction creates a higher revision and `supersedes_id`.
- The restricted publication service and a database trigger reject any recommendation whose canonical inputs reference unconfirmed lab observations.
- A tenant-scoped HMAC lookup hash is unique for external channel identities while the recoverable identifier remains encrypted.
- `domain_outbox` and the business mutation commit in the same PostgreSQL transaction.

**Step 2: Run and verify failure**

Run: `pnpm --filter api test:integration -- database-constraints.e2e-spec.ts`  
Expected: FAIL because tables and constraints are missing.

**Step 3: Implement schema and first migration**

Create the tables listed in the technical design. Use UUIDv7 or database-generated UUIDs consistently, `timestamptz`, explicit enums/check constraints, restricted publication transactions/triggers for cross-table invariants, soft deletion only where legally or operationally required, and append-only tables for events/audits/fact revisions. Add migration rollback notes to the runbook.

**Step 4: Verify**

Run: `pnpm --filter api prisma migrate reset --force`  
Expected: clean database rebuilt from zero.

Run: `pnpm --filter api test:integration`  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/prisma apps/api/src/database apps/api/test infra/runbooks/database-migration.md
git commit -m "feat: add HealthOS persistence model"
```

### Task 4: Implement Sign in with Apple, sessions, and device registration

**Files:**

- Create: `apps/api/src/identity/identity.module.ts`
- Create: `apps/api/src/identity/apple-token-verifier.ts`
- Create: `apps/api/src/identity/session.service.ts`
- Create: `apps/api/src/identity/identity.controller.ts`
- Create: `apps/api/src/identity/dto/*`
- Create: `apps/api/src/identity/*.spec.ts`
- Create: `apps/ios/HealthOS/Features/Auth/*`
- Create: `apps/ios/HealthOS/Core/Security/KeychainStore.swift`
- Test: `apps/ios/HealthOSTests/AuthStoreTests.swift`

**Step 1: Write failing auth tests**

Backend cases: valid Apple token, wrong audience, expired token, replayed nonce, deleted user, refresh rotation, revoked refresh token, duplicate device registration. iOS cases: token persists only in Keychain, logout clears local health cache and tokens, retry preserves onboarding progress.

**Step 2: Run and verify failure**

Run: `pnpm --filter api test -- identity`  
Expected: FAIL.

Run: `xcodebuild -project apps/ios/HealthOS.xcodeproj -scheme HealthOS -destination 'platform=iOS Simulator,name=iPhone 16 Pro,OS=latest' test -only-testing:HealthOSTests/AuthStoreTests`  
Expected: FAIL.

**Step 3: Implement**

Verify Apple JWTs server-side, hash provider subjects, issue short access tokens and rotating refresh tokens, register APNs-capable devices, and record security events. Use resource ownership checks rather than trusting user IDs from request bodies.

**Step 4: Verify**

Run both test commands above.  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/identity apps/ios/HealthOS/Features/Auth apps/ios/HealthOS/Core/Security apps/ios/HealthOSTests/AuthStoreTests.swift
git commit -m "feat: add Apple identity and secure sessions"
```

### Task 5: Implement consent, settings, export, and deletion state machines

**Files:**

- Create: `apps/api/src/consent/*`
- Create: `apps/api/src/privacy/*`
- Create: `apps/worker/src/jobs/privacy/*`
- Create: `apps/ios/HealthOS/Features/Onboarding/Consent/*`
- Create: `apps/ios/HealthOS/Features/Settings/Privacy/*`
- Test: `apps/api/src/consent/*.spec.ts`
- Test: `apps/api/src/privacy/*.spec.ts`
- Test: `apps/ios/HealthOSTests/ConsentStoreTests.swift`

**Step 1: Write failing tests**

Cover versioned grants, consent epochs, withdrawal while a message is queued, notification consent separate from health processing, processing freeze after delete request, deletion tombstones, idempotent export jobs, idempotent deletion retries, backup-restore reconciliation, and a user who reopens the app while deletion is pending.

**Step 2: Run and verify failure**

Run: `pnpm --filter api test -- consent privacy`  
Expected: FAIL.

**Step 3: Implement**

Consent records are append-only and every grant/withdrawal advances a consent epoch. Deletion follows `requested -> frozen -> deleting -> completed | failed_retryable`; export follows `requested -> generating -> ready -> expired`. Completed deletion writes a minimal tombstone outside ordinary restore scope. No feature may infer consent from the mere presence of data, and external sends recheck the current epoch immediately before provider invocation.

**Step 4: Verify**

Run backend and iOS consent tests.  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/consent apps/api/src/privacy apps/worker/src/jobs/privacy apps/ios/HealthOS/Features/Onboarding/Consent apps/ios/HealthOS/Features/Settings/Privacy apps/ios/HealthOSTests/ConsentStoreTests.swift
git commit -m "feat: add consent and privacy lifecycle"
```

### Task 6: Build the native iOS shell and formal design system

**Files:**

- Create: `apps/ios/HealthOS.xcodeproj/*`
- Create: `apps/ios/HealthOS/App/HealthOSApp.swift`
- Create: `apps/ios/HealthOS/App/RootTabView.swift`
- Create: `apps/ios/HealthOS/DesignSystem/ColorTokens.swift`
- Create: `apps/ios/HealthOS/DesignSystem/TypographyTokens.swift`
- Create: `apps/ios/HealthOS/DesignSystem/SpacingTokens.swift`
- Create: `apps/ios/HealthOS/DesignSystem/Components/*`
- Create: `apps/ios/HealthOS/Resources/MoMo/manifest.json`
- Create: `apps/ios/HealthOS/Resources/Assets.xcassets/*`
- Create: `docs/product/DESIGN.md`
- Test: `apps/ios/HealthOSUITests/RootNavigationTests.swift`
- Test: `apps/ios/HealthOSSnapshotTests/*`

**Step 1: Write failing navigation and snapshot tests**

Assert exactly four tabs, stable tab identifiers, accessible labels, active state persistence, Dynamic Type at accessibility sizes, Reduce Motion behavior, and the 390x844 reference layout for Today/Coach/Map/Review shells.

**Step 2: Run and verify failure**

Run: `xcodebuild -project apps/ios/HealthOS.xcodeproj -scheme HealthOS -destination 'platform=iOS Simulator,name=iPhone 16 Pro,OS=latest' test`  
Expected: FAIL because the app shell does not exist.

**Step 3: Implement the shell**

Rebuild visible surfaces as SwiftUI components. Do not embed the four full-screen PNG files. Create a MoMo asset manifest that identifies canonical head, body, pose, anatomy, palette, and supported state. Use the same navigation head asset across all tabs. `docs/product/DESIGN.md` must encode the independent layout grammar for each tab.

**Step 4: Verify visually and functionally**

Run all iOS tests and capture reference screenshots at 390x844 plus one large Dynamic Type size. Compare against `healthos-v1-ios-prototype/design-targets/` with design sign-off.

**Step 5: Commit**

```bash
git add apps/ios docs/product/DESIGN.md
git commit -m "feat: build native HealthOS app shell and design system"
```

### Task 7: Implement HealthKit authorization, aggregation, and offline sync outbox

**Files:**

- Create: `apps/ios/HealthOS/Core/HealthKit/HealthKitClient.swift`
- Create: `apps/ios/HealthOS/Core/HealthKit/HealthKitTypes.swift`
- Create: `apps/ios/HealthOS/Core/HealthKit/HealthAggregator.swift`
- Create: `apps/ios/HealthOS/Core/HealthKit/HealthSyncCoordinator.swift`
- Create: `apps/ios/HealthOS/Core/HealthKit/AnchorStore.swift`
- Create: `apps/ios/HealthOS/Core/HealthKit/SampleIndexStore.swift`
- Create: `apps/ios/HealthOS/Core/HealthKit/SourcePrecedence.swift`
- Create: `apps/ios/HealthOS/Core/Persistence/SyncOutbox.swift`
- Create: `apps/ios/HealthOS/Features/Onboarding/HealthPermissions/*`
- Test: `apps/ios/HealthOSTests/HealthAggregatorTests.swift`
- Test: `apps/ios/HealthOSTests/HealthSyncCoordinatorTests.swift`

**Step 1: Write failing tests**

Use synthetic HealthKit adapters to test full data, partial data, no samples, low HRV sample count, timezone travel, overlapping iPhone/Watch/third-party sources, duplicated anchored samples, deleted samples older than seven days, corrected sleep crossing midnight, corrupt anchor recovery, primary-device handover, offline upload, seven-day rolling recompute, and 90-day reconciliation.

**Step 2: Run and verify failure**

Run the HealthKit unit test target.  
Expected: FAIL.

**Step 3: Implement**

Keep HealthKit behind a protocol so unit tests never depend on live HealthKit. Aggregate to day-level facts on-device. Use anchored queries and an encrypted sample index to locate deletions, persist anchors per sample type, define source precedence and overlap rules, restrict uploads to one primary HealthKit device, schedule best-effort background refresh, recompute seven days on foreground sync, reconcile 90 days weekly/on handover, and always support app-open sync as the reliable path.

**Step 4: Verify**

Run unit tests plus a manual true-device checklist for permissions, background delivery, Apple Watch data, airplane mode, and timezone change.  
Expected: all automated tests PASS and manual evidence recorded in `docs/product/healthkit-device-matrix.md`.

**Step 5: Commit**

```bash
git add apps/ios/HealthOS/Core/HealthKit apps/ios/HealthOS/Core/Persistence apps/ios/HealthOS/Features/Onboarding/HealthPermissions apps/ios/HealthOSTests docs/product/healthkit-device-matrix.md
git commit -m "feat: add HealthKit aggregation and resilient sync"
```

### Task 8: Implement health ingestion and daily fact projections

**Files:**

- Create: `apps/api/src/health/*`
- Create: `apps/api/src/health/dto/health-sync-batch.dto.ts`
- Create: `apps/api/src/health/health-ingestion.service.ts`
- Create: `apps/api/src/health/daily-fact-projector.ts`
- Create: `apps/api/src/health/freshness.service.ts`
- Create: `apps/api/src/health/*.spec.ts`
- Modify: `packages/contracts/openapi/healthos-v1.yaml`
- Create: `apps/ios/HealthOS/Core/API/Generated/*`

**Step 1: Write failing ingestion tests**

Test schema rejection, consent missing, idempotent duplicate batches, immutable fact revisions, server-assigned sequence, source-vector conflict, primary-device rejection, timezone boundaries, impossible numeric values, partial metrics, domain-outbox atomicity, worker dispatch failure, and replay after timeout.

**Step 2: Run and verify failure**

Run: `pnpm --filter api test -- health`  
Expected: FAIL.

**Step 3: Implement**

Validate batches against OpenAPI, store a `health_sync_run`, write immutable daily fact revisions and the current projection transactionally, calculate coverage/freshness, and write the profile-projection event to `domain_outbox` in the same transaction. A lease worker dispatches it with a consumer inbox and reconciliation job. Generate the Swift API client from the checked-in contract; do not hand-maintain duplicate DTOs.

**Step 4: Verify**

Run: `pnpm contract:check && pnpm --filter api test -- health`  
Expected: PASS.

Run iOS sync against local API with a synthetic adapter.  
Expected: one batch, idempotent replay, visible last-sync time.

**Step 5: Commit**

```bash
git add apps/api/src/health packages/contracts apps/ios/HealthOS/Core/API
git commit -m "feat: ingest HealthKit daily facts"
```

### Task 9: Implement secure lab document upload and parsing pipeline

**Files:**

- Create: `apps/api/src/labs/*`
- Create: `apps/worker/src/jobs/labs/*`
- Create: `packages/test-fixtures/labs/*`
- Create: `apps/admin/app/labs/*`
- Create: `apps/ios/HealthOS/Features/Labs/*`
- Test: `apps/api/src/labs/*.spec.ts`
- Test: `apps/worker/src/jobs/labs/*.spec.ts`
- Test: `apps/ios/HealthOSUITests/LabConfirmationTests.swift`

**Step 1: Write failing tests**

Cover invalid MIME, oversized file, SHA mismatch, duplicate document, malicious file result, OCR timeout, parser low confidence, sex/age-specific ranges, unknown or incompatible units, conflicting duplicate fields, free-text ultrasound conclusions, evidence box, abstention, user correction, reviewer confirmation, and deletion during parsing.

**Step 2: Run and verify failure**

Run: `pnpm --filter api test -- labs && pnpm --filter worker test -- labs`  
Expected: FAIL.

**Step 3: Implement one vertical slice**

Start with ALT, AST, GGT, uric acid, BMI, weight, waist, and a medically reviewed subset of liver ultrasound conclusions. Use provider ports for OCR and parsing approved in Task 0. Persist evidence page/box and raw extracted text encrypted. Unknown fields remain visible for manual handling but do not become profile facts.

**Step 4: Verify**

Run at least 100 consented/deidentified reports across the explicitly supported institutions/layouts and the iOS confirmation UI test.  
Expected: high-confidence supported fields achieve >= 98% precision, every unsupported/low-confidence case abstains or requires manual confirmation, corrected values create audit events, and unconfirmed values are unusable.

**Step 5: Commit**

```bash
git add apps/api/src/labs apps/worker/src/jobs/labs apps/admin/app/labs apps/ios/HealthOS/Features/Labs packages/test-fixtures/labs
git commit -m "feat: add confirmed lab ingestion pipeline"
```

### Task 10: Implement profile events and versioned profile snapshots

**Files:**

- Create: `apps/api/src/profile/*`
- Create: `apps/worker/src/jobs/profile/project-profile.job.ts`
- Test: `apps/api/src/profile/*.spec.ts`
- Test: `apps/worker/src/jobs/profile/project-profile.job.spec.ts`

**Step 1: Write failing projection tests**

Test ordered events, duplicate correlation IDs, late events, a corrected lab value, withdrawn consent, user-confirmed limitation, unsupported free text, transactional domain-outbox publication, duplicate consumer delivery, and deterministic projection replay from zero.

**Step 2: Run and verify failure**

Run: `pnpm --filter api test -- profile`  
Expected: FAIL.

**Step 3: Implement**

Make `profile_events` append-only. The projection consumes only allowlisted event types and emits an immutable `profile_snapshot` with a monotonic version. Projection work arrives through `domain_outbox` and records a consumer-inbox result before acknowledgement. A free-text Coach message creates a pending candidate, never a profile event, until confirmed.

**Step 4: Verify**

Run replay twice from the same events.  
Expected: identical snapshot hash and version sequence.

**Step 5: Commit**

```bash
git add apps/api/src/profile apps/worker/src/jobs/profile
git commit -m "feat: add auditable health profile projections"
```

### Task 11: Implement rules, action catalog, safety policy, and 50 golden cases

**Files:**

- Create: `packages/rules/src/action-catalog.ts`
- Create: `packages/rules/src/risk-engine.ts`
- Create: `packages/rules/src/safety-policy.ts`
- Create: `packages/rules/src/rule-bundle.ts`
- Create: `packages/rules/src/*.spec.ts`
- Create: `packages/evals/cases/golden/*.json`
- Create: `packages/evals/cases/adversarial/*.json`
- Create: `packages/evals/src/run-rule-cases.ts`
- Create: `docs/product/safety-taxonomy.md`

**Step 1: Author failing fixtures before rules**

Create 50 cases across sleep recovery, fatty liver, uric acid, waist/weight, missing data, stale data, conflicting data, minors, pregnancy/trying to conceive, serious renal/cardiac/liver conditions, diabetes treatment, medication, eating-disorder risk, mobility limitations, acute symptoms, action rejection, and doctor/blocked questions. Each fixture includes eligibility, trusted input, expected risk area, allowed action codes, safety class, forbidden output, and expected fallback.

**Step 2: Run and verify failure**

Run: `pnpm --filter evals eval:rules`  
Expected: FAIL for all unimplemented cases.

**Step 3: Implement rules and safety configuration**

Rules first enforce eligibility, then select one risk area and one action code. The action catalog carries duration, difficulty, contraindication tags, lighter variants, swap family, and user-facing copy keys. Safety policy is executable structured data, not prompt prose. Every rule-bundle release requires technical and medical approval by different named actors.

**Step 4: Verify**

Run: `pnpm --filter rules test --coverage && pnpm --filter evals eval:rules`  
Expected: 100% branch coverage for domain policy and all golden cases PASS.

**Step 5: Commit**

```bash
git add packages/rules packages/evals docs/product/safety-taxonomy.md
git commit -m "feat: add deterministic advisor rules and safety cases"
```

### Task 12: Implement recommendation runs, immutable snapshots, and rule publishing

**Files:**

- Create: `apps/api/src/recommendations/*`
- Create: `apps/worker/src/jobs/recommendations/*`
- Create: `apps/admin/app/rules/*`
- Create: `apps/admin/app/recommendations/*`
- Test: `apps/api/src/recommendations/*.spec.ts`
- Test: `apps/worker/src/jobs/recommendations/*.spec.ts`

**Step 1: Write failing pipeline tests**

Cover one run per user/date, concurrent duplicate jobs, no usable data, rule conflict, Alpha all-review, Beta allowlisted normal auto-publish, sampled review, caution review, doctor fixed fallback, blocked output, reviewer edit history, superseding revision, missed SLA, medical+technical rule approval, bundle rollback, domain-outbox failure/reconciliation, and global LLM kill switch.

**Step 2: Run and verify failure**

Run: `pnpm --filter api test -- recommendations && pnpm --filter worker test -- recommendations`  
Expected: FAIL.

**Step 3: Implement pipeline**

Snapshot provenance must include the exact canonical rule input, profile snapshot, immutable daily fact revisions, rule/safety/localization/template bundles, prompt version, provider/model identifier, exact rendered user-visible payload, review edits/action, and generation timestamp. Publishing writes the snapshot and domain/channel outbox events in one transaction. The guarantee is retrieval of exactly what was shown/sent plus deterministic replay of the rule decision, not deterministic regeneration by a retired external model.

**Step 4: Verify**

Run recommendation jobs twice for the same day and replay one sent result from stored provenance.  
Expected: no duplicate active action or outbox row; replay matches the rule-selected action and safety class.

**Step 5: Commit**

```bash
git add apps/api/src/recommendations apps/worker/src/jobs/recommendations apps/admin/app/rules apps/admin/app/recommendations
git commit -m "feat: publish reproducible daily recommendations"
```

### Task 13: Build the real Today feature

**Files:**

- Create: `apps/api/src/today/*`
- Create: `apps/ios/HealthOS/Features/Today/TodayView.swift`
- Create: `apps/ios/HealthOS/Features/Today/TodayStore.swift`
- Create: `apps/ios/HealthOS/Features/Today/TodayModels.swift`
- Create: `apps/ios/HealthOS/Features/Today/Components/*`
- Test: `apps/api/src/today/*.spec.ts`
- Test: `apps/ios/HealthOSTests/TodayStoreTests.swift`
- Test: `apps/ios/HealthOSUITests/TodayStateTests.swift`

**Step 1: Write failing state tests**

Cover loading, first launch, partial data, error, active action, completed, permission unavailable, stale data, rejected action, cached-offline, and concurrent server revision. Assert one primary action only and one recovery action in every non-success state.

**Step 2: Run and verify failure**

Run backend Today tests and iOS Today tests.  
Expected: FAIL.

**Step 3: Implement**

Return a versioned `TodayViewModel` from the API. The iOS store renders real components, reads cache first, refreshes in the background, and keeps MoMo copy separate from the artwork. No visible text is baked into runtime PNG assets.

**Step 4: Verify**

Run all automated tests and capture every Today state at 390x844.  
Expected: PASS plus design approval against `design-targets/today.png`.

**Step 5: Commit**

```bash
git add apps/api/src/today apps/ios/HealthOS/Features/Today apps/ios/HealthOSTests/TodayStoreTests.swift apps/ios/HealthOSUITests/TodayStateTests.swift
git commit -m "feat: build Today daily action experience"
```

### Task 14: Implement action feedback, lighter variants, swaps, and offline idempotency

**Files:**

- Create: `apps/api/src/actions/*`
- Create: `apps/ios/HealthOS/Features/Today/ActionFeedbackSheet.swift`
- Create: `apps/ios/HealthOS/Core/Persistence/FeedbackOutbox.swift`
- Test: `apps/api/src/actions/*.spec.ts`
- Test: `apps/ios/HealthOSTests/ActionFeedbackTests.swift`
- Test: `e2e/specs/d3-friction.spec.ts`

**Step 1: Write failing transition tests**

Cover complete, double complete, too hard, no time, tired, uncomfortable, weather, swap, neutral skip, offline replay, stale action version, lighter action unavailable, and a restriction that makes all alternatives unsafe.

**Step 2: Run and verify failure**

Run action unit/integration tests and D3 E2E.  
Expected: FAIL.

**Step 3: Implement**

Use an explicit action state machine. `lighter` and `swap` ask the rules package for an allowed variant, create a replacement assignment, and preserve the old action. If no safe replacement exists, record a neutral skip and explain it.

**Step 4: Verify**

Run tests with rapid taps and airplane mode.  
Expected: one feedback event and at most one replacement.

**Step 5: Commit**

```bash
git add apps/api/src/actions apps/ios/HealthOS/Features/Today/ActionFeedbackSheet.swift apps/ios/HealthOS/Core/Persistence/FeedbackOutbox.swift apps/ios/HealthOSTests/ActionFeedbackTests.swift e2e/specs/d3-friction.spec.ts
git commit -m "feat: close the daily action feedback loop"
```

### Task 15: Implement safe Coach conversations and LLM evals

**Files:**

- Create: `apps/api/src/coach/*`
- Create: `apps/api/src/ai/*`
- Create: `packages/evals/src/run-coach-evals.ts`
- Create: `packages/evals/cases/coach/*.json`
- Create: `apps/ios/HealthOS/Features/Coach/*`
- Test: `apps/api/src/coach/*.spec.ts`
- Test: `apps/ios/HealthOSTests/CoachStoreTests.swift`
- Test: `apps/ios/HealthOSUITests/CoachStateTests.swift`

**Step 1: Write failing routing and eval cases**

Cover explain action, make lighter, swap, record limitation candidate, general question, stale evidence, no evidence, diagnosis request, medication request, emergency language, service-not-monitored disclosure, prompt injection in user text, prompt injection from OCR text, provider timeout, schema violation, citation mismatch, partial-token prohibited output, and conversation-summary drift.

**Step 2: Run and verify failure**

Run: `pnpm --filter api test -- coach ai && pnpm --filter evals eval:coach`  
Expected: FAIL.

**Step 3: Implement**

Classify intent and safety before model invocation. Assemble a minimal structured context from confirmed snapshots. Require structured output, buffer the complete response, validate sources and action codes, then run the safety policy again before displaying anything. High-risk answers use fixed region-aware copy and never invoke the free-generation path.

**Step 4: Verify**

Run all Coach evals against a pinned baseline and provider sandbox.  
Expected: 100% forbidden-output block rate; no action or safety-class mutation; UI preserves draft on timeout.

**Step 5: Commit**

```bash
git add apps/api/src/coach apps/api/src/ai packages/evals apps/ios/HealthOS/Features/Coach apps/ios/HealthOSTests/CoachStoreTests.swift apps/ios/HealthOSUITests/CoachStateTests.swift
git commit -m "feat: add safe evidence-backed Coach"
```

### Task 16: Implement signal snapshots and Map

**Files:**

- Create: `apps/api/src/signals/*`
- Create: `apps/worker/src/jobs/signals/*`
- Create: `apps/ios/HealthOS/Features/Map/*`
- Test: `apps/api/src/signals/*.spec.ts`
- Test: `apps/ios/HealthOSTests/MapStoreTests.swift`
- Test: `apps/ios/HealthOSUITests/MapStateTests.swift`

**Step 1: Write failing signal tests**

Cover improving, stable, watch, stale, unknown, partial data, conflicting drivers, selected signal not found, confidence reduction, and link back to the current Today action.

**Step 2: Run and verify failure**

Run signal and Map tests.  
Expected: FAIL.

**Step 3: Implement**

Generate signal snapshots asynchronously from trusted facts and published actions. The API supplies semantic nodes and selected details; SwiftUI owns spatial layout and accessibility ordering. Never calculate health meaning in the view.

**Step 4: Verify**

Run all eight Map states and VoiceOver traversal.  
Expected: PASS and one selected signal always owns focus.

**Step 5: Commit**

```bash
git add apps/api/src/signals apps/worker/src/jobs/signals apps/ios/HealthOS/Features/Map apps/ios/HealthOSTests/MapStoreTests.swift apps/ios/HealthOSUITests/MapStateTests.swift
git commit -m "feat: add explainable health signal map"
```

### Task 17: Implement Food Risk Scan with correction, not macro estimates

**Files:**

- Create: `apps/api/src/food/*`
- Create: `apps/worker/src/jobs/food/*`
- Create: `apps/ios/HealthOS/Features/FoodScan/*`
- Create: `packages/evals/cases/food/*.json`
- Test: `apps/api/src/food/*.spec.ts`
- Test: `apps/worker/src/jobs/food/*.spec.ts`
- Test: `apps/ios/HealthOSUITests/FoodScanTests.swift`

**Step 1: Write failing cases**

Cover no food, multiple dishes, cropped/incomplete meal, sugary drink, visually ambiguous alcohol, high-oil uncertainty, refined carbs, high-purine uncertainty, unsupported image, provider/data-region disabled, model timeout, low confidence, abstention, and user corrections. Explicitly assert the API does not return kcal/protein/carbs/fat in V1.0.

**Step 2: Run and verify failure**

Run: `pnpm --filter api test -- food && pnpm --filter evals eval:food`  
Expected: FAIL.

**Step 3: Implement**

Upload images through the same secure object pipeline and only to a provider approved in Task 0. Produce dish candidates and allowlisted risk labels with confidence. Low confidence asks the user to confirm or abstains. Corrections are stored as events for future evaluation but do not retrain automatically. The whole feature and each label have independent kill switches.

**Step 4: Verify**

Run at least 300 consented/deidentified Chinese meal fixtures with stratified labels and reviewer adjudication.  
Expected: high-confidence labels achieve >= 90% precision, uncertainty abstains, unsupported precision never appears; otherwise the affected label or feature remains disabled for V1.0.

**Step 5: Commit**

```bash
git add apps/api/src/food apps/worker/src/jobs/food apps/ios/HealthOS/Features/FoodScan packages/evals/cases/food
git commit -m "feat: add confidence-gated food risk scan"
```

### Task 18: Implement weekly review snapshots and privacy-aware sharing

**Files:**

- Create: `apps/api/src/reviews/*`
- Create: `apps/worker/src/jobs/reviews/*`
- Create: `apps/worker/src/jobs/rendering/*`
- Create: `apps/ios/HealthOS/Features/Review/*`
- Test: `apps/api/src/reviews/*.spec.ts`
- Test: `apps/worker/src/jobs/reviews/*.spec.ts`
- Test: `apps/ios/HealthOSUITests/ReviewStateTests.swift`
- Test: `e2e/specs/d7-review.spec.ts`

**Step 1: Write failing weekly cases**

Cover full week, partial week, no actions, all skipped, improving signal, conflicting signals, late data after cutoff, generation retry, immutable revision, private export, redacted share, expired share, and data deletion after share creation.

**Step 2: Run and verify failure**

Run review tests and D7 E2E.  
Expected: FAIL.

**Step 3: Implement**

Generate one conclusion, 2-3 evidence rows, friction summary, and 1-3 next actions from snapshots. Render share assets server-side or in a deterministic renderer with a redacted default. Opening Review never calls the LLM live.

**Step 4: Verify**

Run all eight Review states, privacy snapshot tests, and visual comparison against `design-targets/review.png`.  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/reviews apps/worker/src/jobs/reviews apps/worker/src/jobs/rendering apps/ios/HealthOS/Features/Review e2e/specs/d7-review.spec.ts
git commit -m "feat: add reproducible weekly reviews and sharing"
```

### Task 19: Implement APNs, WeCom binding, outbox delivery, and Universal Links

**Files:**

- Create: `apps/api/src/channels/*`
- Create: `apps/worker/src/jobs/channels/*`
- Create: `apps/api/src/deeplinks/*`
- Create: `apps/ios/HealthOS/Core/Notifications/*`
- Create: `apps/ios/HealthOS/Core/DeepLinks/*`
- Create: `apps/ios/HealthOS/Features/Settings/Channels/*`
- Test: `apps/api/src/channels/*.spec.ts`
- Test: `apps/worker/src/jobs/channels/*.spec.ts`
- Test: `e2e/specs/channel-binding.spec.ts`

**Step 1: Write failing channel tests**

Cover Task 0 WeCom-disabled mode, member/external-contact tenant scope, bind code expiry, bind code replay, employee/tenant migration, wrong user, unbind, opt-out, consent/binding epoch changed while queued, duplicate webhook, APNs invalid token, WeCom rate limit, transient failure, permanent failure, send-success/crash-before-recording, `unknown_after_send`, duplicate worker, sensitive-field redaction, expired deep link, and account switch.

**Step 2: Run and verify failure**

Run channel tests and binding E2E.  
Expected: FAIL.

**Step 3: Implement**

Use provider adapters. The business transaction writes only to `channel_outbox`; PostgreSQL lease workers send with idempotency, consumer inbox and bounded retries. Immediately before external invocation, recheck user status, consent epoch, binding epoch, opt-out and kill switches. Model at-least-once delivery honestly: if a provider accepted the send but recording failed, mark `unknown_after_send` and do not blindly retry. Message templates accept allowlisted fields only. Universal Links require an authenticated resource ownership check after app open.

**Step 4: Verify**

If the Task 0 WeCom gate passed, run sandbox delivery for seven consecutive days before Beta; otherwise verify APNs + in-app delivery and keep all WeCom code/config disabled.  
Expected: zero cross-user delivery, measured duplicate/unknown rate, send-time withdrawal suppression, and every failure visible in operations console.

**Step 5: Commit**

```bash
git add apps/api/src/channels apps/api/src/deeplinks apps/worker/src/jobs/channels apps/ios/HealthOS/Core/Notifications apps/ios/HealthOS/Core/DeepLinks apps/ios/HealthOS/Features/Settings/Channels e2e/specs/channel-binding.spec.ts
git commit -m "feat: add reliable HealthOS delivery channels"
```

### Task 20: Complete the operations and reviewer console

**Files:**

- Create: `apps/api/src/admin/*`
- Create: `apps/api/src/audit/*`
- Create: `apps/api/src/safety-incidents/*`
- Create: `apps/admin/app/(authenticated)/*`
- Create: `apps/admin/components/*`
- Create: `apps/admin/lib/api/*`
- Test: `apps/api/src/admin/*.spec.ts`
- Test: `apps/admin/tests/*`
- Test: `e2e/specs/admin-review.spec.ts`

**Step 1: Write failing RBAC and workflow tests**

Cover reviewer/operator/admin/medical-approver roles, MFA required, lab evidence access, approve/edit/reject, edit reason required, original draft preserved, technical+medical rule approval, reviewer shift/SLA, queue reassignment, backup takeover, missed cutoff suppression, no-real-time-monitoring copy, rule publish/rollback, kill switch, safety incident update, delivery retry/unknown-after-send review, export/delete dual approval, and audit entries.

**Step 2: Run and verify failure**

Run API admin tests, admin component tests, and Playwright E2E.  
Expected: FAIL.

**Step 3: Implement**

Build dense, utilitarian pages with cursor pagination and explicit states. Do not reuse consumer magazine layouts. Every mutation includes a reason, actor, correlation ID, reconstructable changed fields or exact payload revision, and optimistic concurrency version. The staffing plan defines reviewer hours, backup coverage and SLA; the product never implies emergency messages are continuously monitored.

**Step 4: Verify**

Run a normal 20-50-user day and a 2x peak simulation with 100 daily suggestions, 30 attention-required feedback items and 20 lab-field reviews. Include primary reviewer loss halfway through and backup takeover.  
Expected: normal review median under 90 seconds, caution review p95 under 5 minutes, all cutoff-sensitive work handled inside its window, peak reviewer utilization below 70%, backup takeover without lost tasks, and no action without an audit record. If this fails, reduce Beta size or add staffing before Task 27.

**Step 5: Commit**

```bash
git add apps/api/src/admin apps/api/src/audit apps/api/src/safety-incidents apps/admin e2e/specs/admin-review.spec.ts
git commit -m "feat: add HealthOS operations console"
```

### Task 21: Add scheduling, cutoffs, reminders, and user-configurable notification intensity

**Files:**

- Create: `apps/worker/src/jobs/scheduling/*`
- Create: `apps/api/src/reminders/*`
- Create: `apps/ios/HealthOS/Features/Settings/Reminders/*`
- Test: `apps/worker/src/jobs/scheduling/*.spec.ts`
- Test: `apps/api/src/reminders/*.spec.ts`

**Step 1: Write failing time tests**

Cover user timezone, daylight-saving changes, travel, disabled messages, quiet hours, cutoff missed, late HealthKit data, duplicate scheduler execution, daily maximum, and weekly report day changes.

**Step 2: Run and verify failure**

Run scheduler tests with a fake clock.  
Expected: FAIL.

**Step 3: Implement**

Schedule by user timezone and store each planned run with a unique key. Late data never regenerates and resends the same day. Respect quiet hours, channel consent, reminder intensity, and the product cap of one daily advisor report plus at most one behavior reminder.

**Step 4: Verify**

Run a simulated 14-day clock across three timezones.  
Expected: exact expected runs, no duplicates, no messages during quiet hours.

**Step 5: Commit**

```bash
git add apps/worker/src/jobs/scheduling apps/api/src/reminders apps/ios/HealthOS/Features/Settings/Reminders
git commit -m "feat: schedule respectful health reminders"
```

### Task 22: Add observability, feature flags, kill switches, and incident runbooks

**Files:**

- Create: `packages/observability/src/*`
- Create: `apps/api/src/feature-flags/*`
- Create: `apps/api/src/kill-switches/*`
- Create: `apps/worker/src/telemetry/*`
- Create: `infra/observability/*`
- Create: `infra/runbooks/recommendation-incident.md`
- Create: `infra/runbooks/channel-incident.md`
- Create: `infra/runbooks/privacy-incident.md`
- Test: `apps/api/src/kill-switches/*.spec.ts`
- Test: `e2e/specs/correlation-trace.spec.ts`

**Step 1: Write failing observability tests**

Assert one correlation ID links sync run, recommendation run, snapshot, outbox, delivery attempt, and feedback. Assert health text and lab values are redacted. Test global/channel/rule/user kill switches and cache invalidation.

**Step 2: Run and verify failure**

Run observability and kill-switch tests.  
Expected: FAIL.

**Step 3: Implement**

Instrument API and worker with OpenTelemetry. Publish SLO dashboards and alerts for stale sync, failed generation, safety block spikes, queue backlog, delivery failure, and unauthorized access. Write runnable incident steps with owner, evidence, mitigation, recovery, and notification.

**Step 4: Verify**

Inject a provider outage and activate the LLM kill switch.  
Expected: template fallback, alert, trace, no unsafe or cross-user delivery; duplicate/unknown-after-send states are measured and recoverable.

**Step 5: Commit**

```bash
git add packages/observability apps/api/src/feature-flags apps/api/src/kill-switches apps/worker/src/telemetry infra/observability infra/runbooks e2e/specs/correlation-trace.spec.ts
git commit -m "feat: add production observability and safety controls"
```

### Task 23: Complete end-to-end, accessibility, and visual regression coverage

**Files:**

- Create: `e2e/specs/d0-onboarding.spec.ts`
- Create: `e2e/specs/d1-daily-loop.spec.ts`
- Modify: `e2e/specs/d3-friction.spec.ts`
- Modify: `e2e/specs/d7-review.spec.ts`
- Create: `apps/ios/HealthOSUITests/AccessibilityAuditTests.swift`
- Create: `apps/ios/HealthOSSnapshotTests/AllStatesSnapshotTests.swift`
- Create: `docs/product/state-coverage-matrix.md`

**Step 1: Enumerate every branch before adding tests**

The matrix must list all eight states for each tab, auth/session failures, HealthKit states, lab states, action transitions, Coach safety paths, channel failures, and privacy workflows. Mark each with unit/integration/E2E/eval/visual coverage.

**Step 2: Run the full suite and record gaps**

Run: `pnpm test:all` and the iOS test plan.  
Expected: FAIL until every P0/P1 gap is implemented.

**Step 3: Add the missing tests**

Do not create assertion-free smoke tests. User-visible errors must assert copy category, recovery action, and persisted result. Accessibility tests cover VoiceOver labels/order, Dynamic Type, contrast, Reduce Motion, switch control targets, and color-independent states.

**Step 4: Verify**

Run full suites twice from a clean database.  
Expected: PASS with no order dependence and an approved visual comparison board.

**Step 5: Commit**

```bash
git add e2e apps/ios/HealthOSUITests apps/ios/HealthOSSnapshotTests docs/product/state-coverage-matrix.md
git commit -m "test: cover HealthOS V1 user journeys and states"
```

### Task 24: Perform security and privacy hardening

**Files:**

- Create: `apps/api/test/security/*`
- Create: `infra/security/*`
- Modify: `docs/product/threat-model.md`
- Modify: `docs/product/data-inventory.md`
- Create: `.github/workflows/security.yml`
- Modify: all logging/error-tracking configuration files as findings require

**Step 1: Turn the M0 threat model into failing abuse tests**

Cover IDOR, token replay, refresh theft, bind-code theft, report URL leakage, SSRF through upload callbacks, malicious PDF, admin privilege escalation, mass export, prompt injection, poisoned OCR, webhook forgery, queue replay, and deletion bypass.

**Step 2: Run security tests and scanners**

Run: `pnpm test:security` plus dependency, secret, container, and Terraform scans.  
Expected: any unmitigated high/critical issue FAILS the build.

**Step 3: Fix findings and document residual risk**

Use resource-level authorization, strict upload allowlists, webhook signatures, short-lived signed URLs, rate limits, CSP, KMS, log redaction, and admin MFA. No health data may be sent to third-party analytics. This task validates and hardens the Task 0 architecture; first discovery of the data inventory or trust boundaries here is a release-process failure.

**Step 4: Verify**

Run tests, scanners, and a manual privacy data-flow review.  
Expected: zero open high/critical findings; residual medium risks have owner and due date.

**Step 5: Commit**

```bash
git add apps/api/test/security infra/security docs/product .github/workflows/security.yml
git commit -m "security: harden HealthOS health-data flows"
```

### Task 25: Validate performance, reliability, backup, and recovery

**Files:**

- Create: `e2e/performance/*`
- Create: `infra/runbooks/backup-restore.md`
- Create: `infra/runbooks/disaster-recovery.md`
- Create: `infra/scripts/backup-verify.sh`
- Create: `infra/scripts/restore-drill.sh`
- Create: `docs/product/slo.md`

**Step 1: Write failing SLO checks**

Generate separate test profiles: 100 synthetic users for expected V1 concurrency, 1,000 users for headroom, 14 days of facts, daily recommendations, concurrent Coach messages, weekly reviews, channel sends, worker restarts and admin queue browsing. Include provider latency/failure injection and a 24-hour soak. The SLO document defines each metric's numerator, denominator, observation window, minimum sample count, exclusions and error budget; a load test alone does not prove monthly availability.

**Step 2: Run baseline**

Run: `pnpm perf:test`  
Expected: capture baseline; fail any target outside the SLO document.

**Step 3: Optimize only measured bottlenecks**

Add indexes, bounded concurrency, batch writes, snapshot reads, queue limits, and caches where evidence requires. Do not introduce microservices.

**Step 4: Run recovery drill**

Restore a production-like encrypted backup into an isolated environment, run integrity checks, and verify RPO <= 24 hours and RTO <= 4 hours. The restored system starts in no-send mode, reapplies deletion tombstones and latest consent/binding epochs, reconciles all domain/channel outbox rows, then explicitly unlocks delivery. Simulate a worker crash and leased-message timeout; PostgreSQL outbox/inbox state must allow safe replay.

**Step 5: Commit**

```bash
git add e2e/performance infra/runbooks infra/scripts docs/product/slo.md
git commit -m "perf: validate HealthOS reliability and recovery"
```

### Task 26: Build staging and production infrastructure and deployment pipelines

**Files:**

- Create: `infra/terraform/modules/*`
- Create: `infra/terraform/environments/staging/*`
- Create: `infra/terraform/environments/production/*`
- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/deploy-staging.yml`
- Create: `.github/workflows/deploy-production.yml`
- Create: `.github/workflows/ios-testflight.yml`
- Create: `infra/runbooks/release.md`
- Create: `infra/runbooks/rollback.md`

**Step 1: Write failing infrastructure checks**

Require encrypted database/object storage, private network boundaries, backups, KMS, secret manager, least-privilege service roles, separate staging/production, health checks, log retention, and no public database endpoints.

**Step 2: Run validation**

Run: `terraform fmt -check -recursive infra/terraform && terraform validate` in each environment.  
Expected: FAIL until modules are complete.

**Step 3: Implement pipelines**

CI builds immutable images. Staging auto-deploys after `main` passes. Production requires approval, backward-compatible migration, canary API/worker, smoke tests, and rollback command. TestFlight workflow archives signed iOS builds and records backend/rule/API contract versions.

**Step 4: Verify in staging**

Deploy from a clean runner, run D0/D1/D3/D7 synthetic E2E, rotate one secret, and roll back one intentionally bad canary.  
Expected: repeatable success without a developer laptop.

**Step 5: Commit**

```bash
git add infra/terraform .github/workflows infra/runbooks/release.md infra/runbooks/rollback.md
git commit -m "ops: add repeatable HealthOS deployment pipelines"
```

### Task 27: Execute TestFlight Alpha/Beta and release gates

**Files:**

- Create: `docs/release/v1-alpha-checklist.md`
- Create: `docs/release/v1-beta-checklist.md`
- Create: `docs/release/v1-app-store-checklist.md`
- Create: `docs/release/beta-operations.md`
- Create: `docs/release/known-risks.md`
- Modify: `TODOS.md` only for explicitly approved post-V1 items

**Step 1: Prepare Alpha evidence**

Confirm the Task 0 gates remain valid and record named owners for privacy/data region, medical review, enabled channels, Apple Developer, incident response, and backups. Attach test/eval/security/performance results, migration version, rule bundle, model/prompt baseline, metric contracts and rollback version.

**Step 2: Run 5-person internal Alpha for 14 days**

Track sync freshness, recommendation generation, manual edits, delivery, action feedback, report generation, support requests, safety blocks, and operational time. No direct database repair is allowed as a normal workflow.

**Step 3: Resolve every P0/P1 and repeat failed gates**

Any sensitive-data leak, unsafe recommendation, cross-user access, lost feedback, irreproducible snapshot, or unrecoverable migration resets the release clock.

**Step 4: Run 20-50 person Beta**

Exit criteria:

- 14-day HealthKit valid-sync user ratio >= 80%.
- D1 delivery/read confirmation >= 90%/80%.
- D7 weekly Review open >= 50%.
- At least three feedback events from >= 50% of users.
- Usefulness >= 4/5 and continue intent >= 50%.
- Major reviewer rewrite <= 20% for normal recommendations.
- Unsafe delivery, wrong recipient, and unauthorized access = 0.
- All production SLOs met for four weeks before open registration.

Every line above uses the signed definitions in `docs/product/metrics-contract.md`. In particular, “valid sync”, “read confirmation”, “unsafe delivery”, “channel success” and “major rewrite” must have an explicit denominator, observation window, exclusion list and minimum event count. Unknown provider delivery is not counted as confirmed success.

**Step 5: Release decision and commit evidence**

```bash
git add docs/release TODOS.md
git commit -m "docs: record HealthOS V1 release readiness"
```

## 4. Parallel Worktree Execution

| Lane | Sequential tasks | Can start |
|---|---|---|
| Preflight | 0 | Immediately; all other lanes wait for applicable gates |
| A Backend core | 1 -> 2 -> 3 -> 4 -> 5 -> 8 -> 10 -> 12 | Task 0 architecture gates |
| B iOS foundation | 6 -> 7 -> 13 -> 14 -> 15 -> 16 -> 18 | Task 0 Apple gate and Task 2 contract draft |
| C Data/operations | 9 -> 20 -> 21 | Task 0 provider/medical gates, Task 3 schema and Task 4 identity |
| D Rules/quality | 11 -> Coach/Food eval support -> 23 -> 24 -> 25 | Task 0 medical/threat model and Task 2 |
| E Channels/release | 19 -> 22 -> 26 -> 27 | Task 0 channel decision, Task 4 identity and Task 12 published snapshots |

Recommended merge order:

```text
Task 0 on main
  -> Task 1-3 on main
  -> launch B + D in parallel
  -> A continues identity/consent/ingestion
  -> launch C after schema + identity
  -> launch E after recommendation snapshot contract
  -> merge vertical slices one by one
  -> hardening tasks 23-25
  -> infrastructure and release tasks 26-27
```

Conflict rules:

- Only Lane A owns Prisma schema until Task 12; other lanes request schema changes through a small contract PR.
- Only Lane D owns golden-case schemas and safety policy.
- Only Lane B owns `docs/product/DESIGN.md` and the MoMo asset manifest.
- Only Lane E owns shared outbox provider interfaces after Task 19 begins.

## 5. Required Inline Diagrams During Implementation

Add and maintain ASCII comments in these files because their state or data flow is non-obvious:

- `apps/ios/HealthOS/Core/HealthKit/HealthSyncCoordinator.swift`: anchor, aggregation, offline and retry flow.
- `apps/api/src/profile/profile-projector.ts`: event-to-snapshot projection.
- `packages/rules/src/risk-engine.ts`: risk selection and conflict resolution.
- `apps/worker/src/jobs/recommendations/generate-recommendation.job.ts`: input-to-publish pipeline.
- `apps/api/src/actions/action-state-machine.ts`: action transitions.
- `apps/api/src/coach/coach-orchestrator.ts`: intent/safety/model/output flow.
- `apps/worker/src/jobs/channels/deliver-outbox.job.ts`: lease, attempt, retry and terminal states.
- `apps/worker/src/jobs/privacy/delete-user.job.ts`: resumable deletion state machine.

Any later code change touching these flows must update the diagram in the same commit.

## 6. Definition of Done

A task is done only when:

- Its behavior and failure-path tests pass locally and in CI.
- Its OpenAPI/database changes are backward compatible or have a staged migration plan.
- User-visible error and recovery states exist.
- Logs and analytics contain no sensitive health payload.
- Accessibility labels and Dynamic Type are verified for iOS UI work.
- Correlation IDs and audit events exist for health-affecting mutations.
- Documentation and runbooks reflect the real implementation.
- The task's commit contains only its declared scope.

V1.0 is done only after Task 27 Beta gates pass. “The four screens look right” is not a release criterion.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|---|---|---|---:|---|---|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 in current log | — | Existing layered PRD was used as source material |
| Codex Review | outside voice | Independent second opinion | 1 | ISSUES FOUND, INTEGRATED | Found compliance, HealthKit, WeCom, async durability, safety, timeline and operations gaps; plan was revised and rechecked |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 | CLEAR | Latest review: 13 issues addressed, 0 unresolved decisions, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 completed in current log | — | Existing in-progress V1 design plan remains the visual/interaction source |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**CROSS-MODEL:** The independent reviewer rejected the first draft for production use. After revision it marked the prior compliance, HealthKit, WeCom, async, timeline, snapshot, consent, delivery, App Store and corpus gaps resolved; reviewer-capacity testing was then added to Task 20.

**UNRESOLVED:** 0 technical-plan decisions. Task 0 contains named organizational and regulatory gates that must pass before applicable implementation begins.

**VERDICT:** ENG CLEARED. Ready to begin Task 0, not yet authorized to process real health data or ship to production.
