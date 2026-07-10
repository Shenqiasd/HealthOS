# Privacy lifecycle and restore runbook

This runbook covers consent epochs, exports, deletion, and post-restore no-send
reconciliation. It uses synthetic evidence only. Retention periods, legal holds,
production regions, and provider approvals remain pending human decisions and
must not be inferred from this implementation.

## Required separation

`PRIVACY_CONTROL_PATH` must be an encrypted, access-controlled volume that is
not part of the ordinary application PostgreSQL backup or restore set. It holds
append-only deletion-fence and send-gate journals. Restoring PostgreSQL without
this volume is fail-closed because a missing gate is treated as blocked.

Required API secrets are supplied by the approved secret manager:

- `DELETION_TOMBSTONE_HASH_KEY`
- `DELETION_TOMBSTONE_HASH_KEY_VERSION`
- `DELETION_STATUS_TOKEN_KEY`
- `PRIVACY_CONTROL_PATH`

The worker keeps every still-relevant tombstone HMAC key indexed by key version
until the approved backup and restore horizon no longer requires it. Never put
secret values, status tokens, user IDs, or health content in change receipts.

## Consent and provider sends

Consent writes append a record and advance the user's global epoch under a row
lock. Each queued item stores every required purpose and the exact grant epoch.
The provider callback runs while holding the same user row lock used by a
withdrawal, so the send decision and withdrawal have a defined order. A
withdrawal suppresses matching pending or leased work, and a later re-grant
never revives that old item.

Channels must also verify the external send gate. A missing or blocked gate,
missing consent requirement, inactive user, stale grant epoch, or incomplete
reconciliation suppresses the item. Provider idempotency keys remain mandatory
because a network result can still be `unknown_after_send`.

## Export processing

1. Claim `requested` or `failed_retryable` with a unique lease token and expiry.
2. Write the machine-readable artifact to the approved object store.
3. Verify its SHA-256 and persistence before publishing `ready` with an explicit
   expiry supplied by the approved retention policy.
   The public status API exposes availability only; a later approved adapter
   must mint a short-lived signed download URL without exposing the object key.
4. Reject stale lease tokens. A crashed lease may be reclaimed after expiry.
5. Move `ready` to `expired` and remove the object under the approved policy.

There is intentionally no built-in retention duration. Do not publish an export
as ready until the object-store adapter and retention decision are approved.

## Deletion processing

1. The API writes a pending keyed deletion fence to the external privacy volume.
2. In one PostgreSQL transaction it creates the job, freezes the user, revokes
   refresh sessions, suppresses channel and domain outboxes, and records the
   security event.
3. The worker claims the frozen job with a lease. Failures remain retryable and
   never unfreeze the user.
4. Before destructive deletion, the worker appends the completed external fence.
   A crash after this point is safe: restore reconciliation will still delete the
   user, and the worker can retry idempotently.
5. The worker invokes `healthos_delete_frozen_user` and completes the job with
   `user_id = NULL`. Production migrations must grant this security-definer
   function only to the dedicated privacy worker role.

The external fence contains only keyed user lookup hash, key version, deletion
job ID, status, and timestamps. The scoped status token can read that one job;
it cannot authenticate ordinary API or health processing.

## Database restore

1. Stop all send-capable workers and block the external gate before restoring
   PostgreSQL. Do not trust a restored database row that says `ready`.
2. Restore the ordinary database without overwriting the privacy-control volume.
3. Run reconciliation with a unique restore run ID and backup ID.
4. Reconciliation removes users matching completed external fences and
   suppresses channel/domain outboxes whose user, purposes, or grant epochs are
   invalid.
5. Confirm the database reconciliation row is `ready`, then append the matching
   external gate `allowed` entry and restart senders.
6. If any step fails, leave the external gate blocked, preserve evidence, and
   rerun with the same backup context after fixing the cause.

## Rollback and key rotation

Application rollback may keep the new additive tables, but old code must not run
senders unless it honors the external gate and consent requirements. Never roll
back by deleting fences or resetting consent epochs.

For tombstone HMAC rotation, start writing a new key version while retaining old
versions for reconciliation. For deletion status-token rotation, keep the key
stable for all active jobs; rotating it early can prevent a user from reading
pending status. Record versions and rollback owners, never key material.
