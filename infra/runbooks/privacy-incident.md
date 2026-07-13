# Privacy incident runbook

Status: synthetic exercise only. Owner role: privacy incident commander, paired
with security and an MFA-authenticated operator. Named production, legal, and
regulatory authority remain pending.

## Evidence

1. Block send-capable workers and the external privacy send gate. Record only
   redacted correlation IDs, event counts, schema/app versions, control revision
   numbers, backup ID, and reconciliation state.
2. Preserve audit logs, deletion fences, consent epochs, outbox suppression
   states, access events, and deployment evidence. Never copy health text, lab
   values, account/channel identifiers, tokens, raw requests, or stack traces.
3. Determine whether impact is unauthorized access, wrong-user delivery,
   consent withdrawal bypass, deletion resurrection, telemetry leakage, or an
   unapproved data-region/export path.

## Mitigation

Activate `global.proactive_messages`, stop affected workers, revoke compromised
credentials through the approved secret manager, and keep privacy reconciliation
fail closed. Do not delete evidence or mutate append-only records.

## Recovery And Rollback

1. Fix forward or roll back code with all sends blocked.
2. Restore only to a new database from verified backup evidence, then reconcile
   completed deletion fences, consent, and outboxes before reopening traffic.
3. Run privacy deletion, restore, authorization, safety-control deletion, and
   telemetry redaction tests using synthetic data.
4. Append control deactivation only after privacy and security owners approve;
   never rewrite the activating revision.

## Notification

Escalate immediately to privacy, security, legal, product, and medical-safety
roles. User, provider, Apple, or regulator notification requires named authority,
jurisdiction assessment, approved timing, and approved wording; this runbook
does not grant any of them.
