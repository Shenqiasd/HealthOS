# HealthOS V1 Threat Model

Status: `pending named security owner`

## Assets

Identity links, HealthKit facts, lab/food objects, profile snapshots, recommendation provenance, Coach messages, channel bindings, signing material, provider credentials, reviewer actions, deletion state, and audit evidence.

## Primary Threats And Controls

| Threat | Required controls | Release evidence |
|---|---|---|
| Cross-user API access | object-level authorization, opaque IDs, negative tests | security E2E |
| Channel misbinding or stale consent | tenant-scoped HMAC, encrypted ID, consent epoch, send-time authorization | zero wrong-recipient tests |
| Report upload abuse | signed short-lived upload, checksum/type/size validation, malware scan, private object ACL | upload corpus and fault tests |
| Prompt injection from OCR/user text | treat as data, typed parser, no tool interpolation, allowlisted context | adversarial eval |
| Unsafe LLM output | deterministic policy, structured schema, post-check, fixed fallback, kill switch | 30 adversarial cases |
| Credential leakage | secret manager, redaction, push protection, rotation and least privilege | secret scan and rotation drill |
| Sensitive telemetry | field allowlist, health-payload detector, sampled review | log/analytics audit |
| Replay or duplicate mutation | idempotency keys, inbox/outbox uniqueness, signed callbacks | integration tests |
| Admin abuse | RBAC, step-up auth, least privilege, immutable audit trail | role matrix tests |
| Deletion failure | resumable state machine, provider receipts, backup-expiry policy | deletion and restore drill |
| Supply-chain compromise | lockfiles, dependency review, SBOM, signed build provenance | CI evidence |
| Device compromise | Keychain protection, no report cache by default, screen privacy review | iOS security review |

## Safety Defaults

- Fail closed for ambiguous identity, authorization, consent, binding, and provider state.
- Disable external AI/OCR/channel adapters independently.
- Keep emergency language fixed and locally available.
- Never include health details in push previews, URLs, logs, or analytics.
- Production access and incident response require named primary and backup owners.

Security approval requires a reviewed data-flow diagram, abuse cases, mitigation owners, penetration-test scope, incident playbook, key rotation, backup restore, and deletion rehearsal.
