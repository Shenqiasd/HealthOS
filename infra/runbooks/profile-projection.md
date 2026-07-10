# Profile Projection Operations

## Scope

This runbook covers the append-only `profile_events` ledger, immutable
`profile_snapshots`, pending `profile_candidates`, and the
`profile.event.appended` worker. Use synthetic fixtures outside approved
environments. Never place health payloads or candidate source text in logs.

## Invariants

- Server-assigned `profile_events.sequence` is the ledger order. `occurred_at`
  is business time and never reorders history.
- Event and snapshot rows cannot be updated. Runtime deletion is authorized
  only by `healthos_delete_frozen_user`, which installs a private
  transaction-scoped authorization before cascading a frozen user's data. The
  database owner retains an audited migration/emergency path; application roles
  cannot gain it by setting the legacy GUC or using `SET ROLE`.
- Before production migration, a DBA must provision the NOLOGIN group role
  `healthos_privacy_worker` and grant the worker login membership. The migration
  conditionally grants that role `EXECUTE` on the security-definer deletion
  function and emits a notice when the role is absent. If the role is created
  after migration, the DBA must run the explicit function grant below. The
  ordinary API role must never be a member.

```sql
CREATE ROLE healthos_privacy_worker NOLOGIN;
GRANT healthos_privacy_worker TO <worker_login>;
GRANT EXECUTE ON FUNCTION healthos_delete_frozen_user(UUID)
  TO healthos_privacy_worker;
```
- A candidate stores only a typed value and a SHA-256 source-text hash. Its
  typed content cannot change after insertion, and only explicit confirmation
  creates an event plus outbox row.
- Every snapshot records its source event, source sequence, consent epoch,
  canonical facts, and SHA-256 hash. Composite foreign keys prevent cross-user
  provenance.
- A worker locks the user before the outbox row, verifies a live lease and the
  exact current consent epoch, writes all missing versions, records
  `consumer_inbox`, and acknowledges the message in one transaction.

## Replay And Drift Check

Replay is a pure shadow calculation from events ordered by `sequence`. Do not
delete, overwrite, or renumber production snapshots.

1. Select one user and one consent epoch under approved support access.
2. Read events ordered by `sequence`; do not sort by `occurred_at`.
3. Run the projector in shadow mode and compare every tuple of `version`,
   `source_sequence`, and `snapshot_hash` with stored snapshots.
4. If any tuple differs, stop profile and recommendation workers for that user,
   preserve the event/outbox/inbox rows, and open a P0 data-integrity incident.
5. Resume only after a reviewed forward-only repair. Never mutate ledger rows.

## Lease Recovery

- A message with `available_at` in the future is not claimable.
- A worker may reclaim only `pending`, `failed`, or expired `leased` work.
- A stale token or expired lease cannot commit, even if no replacement worker
  has claimed the row yet.
- On a process exception, the transaction leaves snapshots, inbox, and ack
  unchanged. The scheduler may mark the message `failed` with sanitized error
  metadata and retry with a new lease.

## Consent Withdrawal

Consent writes and projection both lock the user row first. If withdrawal wins,
projection is suppressed. If projection commits first, the withdrawal call
waits for it and all later snapshot reads reject the old consent epoch. Confirm
that no downstream recommendation outbox was created after the withdrawal
epoch before resolving the incident.

## Monitoring

Alert on oldest pending age, expired lease count, replay divergence, repeated
correlation conflicts, unsupported event types, suppressed projections, and
candidate confirmation failures. Metrics and logs contain identifiers and
counts only, never fact values or source text.
