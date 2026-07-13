# Channel incident runbook

Status: synthetic control-plane exercise only. Owner role: channel operator.
There is no production APNs/WeCom provider integration in this tranche, and
`channel.delivery` is not yet wired to a real send-time boundary. Do not claim
containment of an external provider until Task 19 proves that integration.

## Evidence

Record channel code, template version, redacted correlation IDs, accepted,
failed, suppressed, duplicate, and `unknown_after_send` counts, queue age, and
current control revisions. Never record provider tokens, external identifiers,
message bodies, health values, user IDs, or raw provider responses.

## Mitigation

1. Stop the real channel worker at deployment level until send-time switch
   enforcement is implemented and verified.
2. Append `channel.delivery` for `apns` or `wecom`, and if exposure is unclear
   also append `global.proactive_messages`. Mutation requires MFA operator/admin
   authority and same-transaction audit evidence.
3. Do not auto-fallback between channels. Preserve `unknown_after_send` for
   manual/provider reconciliation and do not blindly retry.

## Recovery And Rollback

1. Fix or roll back the adapter while channel processing stays stopped.
2. Recheck user status, consent epoch, binding epoch, opt-out, privacy gate, and
   current switch immediately before every synthetic provider invocation.
3. Reconcile provider evidence and append a deactivation revision only after
   bounded synthetic delivery and duplicate tests pass.

## Notification

Escalate to security and privacy roles for cross-user, wrong-binding, or health
payload exposure. User/provider/regulator notification needs named authority;
do not send it from this exercise.
