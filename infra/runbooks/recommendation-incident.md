# Recommendation incident runbook

Status: synthetic exercise only. Owner role: on-call engineer with a separate
MFA-authenticated operator for safety-control mutation. Named production owners
and notification authority remain pending.

## Evidence

1. Record incident time, deployed versions, redacted correlation IDs, queue age,
   failure and safety-block counts, active rule bundle, and current control
   revision numbers. Do not record health text, lab values, user IDs, prompts,
   model responses, tokens, or exception payloads.
2. Confirm privacy reconciliation is ready and distinguish rule failure, worker
   failure, stale input, provider failure, and an expected safety block.
3. Preserve immutable recommendation run, snapshot, audit, outbox, inbox, and
   safety-control revision evidence. Never repair by editing these rows.

## Mitigation

1. For model/provider uncertainty, activate `llm.generation` so deterministic
   rule templates continue. For unsafe or unexplained output, activate
   `global.proactive_messages`, the exact `rule.bundle`, or exact
   `user.recommendations` switch as narrowly as evidence permits.
2. Every mutation requires MFA operator/admin RBAC, correlation ID, an allowlisted reason code,
   expected version, idempotency key, and same-transaction audit consumption.
3. Verify a synthetic run is suppressed or records
   `llm_kill_switch_active=true`; verify no new publication/outbox appears for a
   stopped path.

## Recovery And Rollback

1. Fix forward or roll back application code while controls remain active.
2. Re-run deterministic rules, recommendation, safety-control, migration, and
   redaction tests with synthetic data.
3. Append a deactivation revision; never update/delete the activating revision.
4. Verify bounded catch-up cannot publish stale-consent or stale-profile work.

## Notification

Escalate to safety, privacy, medical-review, security, and product owner roles
according to impact. User or regulator notification requires named authority and
approved wording; this runbook does not grant it.
