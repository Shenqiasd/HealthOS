# Health ingestion runbook

The HealthOS V1 ingestion API accepts synthetic or user-consented day-level
aggregates only. It does not accept raw HealthKit samples and does not claim
native HealthKit, entitlement, background-delivery, or true-device readiness.

## Acceptance boundary

- The access token owns the user; request bodies never contain `user_id`.
- The current `health_processing` consent record must be granted.
- The device must belong to the user and be the single primary health device.
- One idempotency key identifies one canonical request body. Exact replay returns
  the original run; changed reuse is rejected.
- PostgreSQL assigns a monotonic server sequence. Gaps after rolled-back
  transactions are expected and must not be repaired or reused.
- Each changed date/metric appends a fact revision. The current view orders by
  server sequence and never overwrites historical facts.
- Fact revisions and the `health.facts.accepted` domain event commit together.
  The event carries the exact health-consent grant epoch.

## Supported V1 metrics

`steps`, `active_energy_kcal`, `exercise_minutes`, `sleep_minutes`,
`resting_heart_rate_bpm`, `hrv_ms`, `workout_minutes`, `weight_kg`, and
`vo2_max`. Values are structural daily aggregates with bounded ranges; they are
not diagnoses or medical interpretations.

## Worker recovery

The health profile dispatcher claims one domain event with a lease token. It
rechecks active user and exact consent grant epoch inside the processing
transaction, writes `ConsumerInbox` before marking the event sent, and suppresses
stale or withdrawn work. A crashed lease may be reclaimed after expiry. A stale
lease token cannot publish a profile event.

For replay or timeout investigation, compare `health_sync_runs.request_hash`,
`server_sequence`, fact revision IDs, domain outbox ID, and consumer inbox row.
Never log aggregate values, source IDs, access tokens, or request bodies.

## Rollback

The migration is additive except for replacing the current-facts view. Rollback
must stop ingestion and the health dispatcher first. Do not delete fact
revisions or decrement/reseed the server sequence. Restore the prior view only
after confirming no new revision depends on the added sequence columns.
