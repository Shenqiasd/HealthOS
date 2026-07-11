# HealthOS Database Migration Runbook

## Scope

HealthOS uses PostgreSQL as the source of truth and Prisma migrations as the ordered schema history. Production migrations are forward-only artifacts reviewed in pull requests. Real health data is prohibited until the applicable governance gates pass.

## Local Verification

1. Start an isolated PostgreSQL 17 instance with synthetic credentials.
2. Set `DATABASE_URL` only in the process environment or secret manager.
3. Run `pnpm --filter @healthos/api prisma validate`.
4. Run `pnpm --filter @healthos/api prisma migrate reset --force` against a disposable database.
5. Run `pnpm --filter @healthos/api test:integration`.
6. Confirm `pnpm lint`, `pnpm typecheck`, and `pnpm test` remain green.

Never run `migrate reset` against shared staging or production.

## Deployment Sequence

1. Capture the application version, migration checksum, current schema version, database target, backup identifier, and rollback owner.
2. Verify a recent encrypted backup and a restore drill that satisfies the approved RPO/RTO.
3. Apply backward-compatible expand changes with `prisma migrate deploy` before deploying code that reads them.
4. Deploy application and worker code with feature flags disabled where appropriate.
5. Backfill in resumable, idempotent batches with progress and error metrics.
6. Enable reads, then writes, while monitoring locks, query latency, error rate, outbox lag, and backup health.
7. Perform contract changes only after the old application version and old data representation are no longer needed.

## Rollback

Prisma down migrations are not generated. Roll back application code first when the expand schema remains backward compatible. For a destructive or corrupting migration:

- stop affected writers with the feature or module kill switch;
- preserve audit and incident evidence;
- restore to a new database from the verified backup;
- replay only idempotent outbox/input events after the restore boundary;
- reconcile deletion requests before reopening traffic;
- switch the application only after row counts, constraints, checksums, and safety queries pass.

Never patch production schema manually without creating an equivalent checked-in migration and incident record.

## Required Migration Review

- lock level and expected duration;
- table rewrite and disk-growth risk;
- index creation strategy;
- forward and backward application compatibility;
- data backfill idempotency;
- privacy retention and deletion effects;
- append-only/audit preservation;
- rollback owner, backup ID, RPO/RTO, and validation queries.

## HealthOS Invariants

- Fact revisions, profile events/snapshots, recommendation snapshots, weekly reviews, and audits are append-only.
- Recommendation corrections create a higher revision and reference the prior snapshot.
- Published recommendations cannot reference missing or unconfirmed lab observations.
- One active primary action exists per user and local date.
- Outbox idempotency keys are globally unique.
- Channel lookup hashes are unique per tenant; recoverable identifiers remain encrypted.
- Business mutations and their domain outbox event commit in one transaction.

Append-only DELETE triggers permit cascaded privacy deletion only inside a transaction that explicitly runs `SET LOCAL healthos.allow_privacy_delete = 'on'`. Only the future reviewed deletion worker may use this setting. It never permits UPDATE and must not be enabled at a session or database level.
