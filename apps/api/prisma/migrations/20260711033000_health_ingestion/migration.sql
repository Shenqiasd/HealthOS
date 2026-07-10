CREATE SEQUENCE "health_sync_server_sequence" START WITH 1 INCREMENT BY 1;

ALTER TABLE "health_sync_runs"
ADD COLUMN "idempotency_key" TEXT,
ADD COLUMN "request_hash" TEXT,
ADD COLUMN "timezone" TEXT,
ADD COLUMN "consent_epoch" INTEGER;

UPDATE "health_sync_runs" AS run
SET
  "idempotency_key" = 'migration:' || run."id"::TEXT,
  "request_hash" = 'migration:' || run."id"::TEXT,
  "timezone" = subject."timezone",
  "consent_epoch" = 0,
  "server_sequence" = nextval('health_sync_server_sequence')
FROM "users" AS subject
WHERE subject."id" = run."user_id";

ALTER TABLE "health_sync_runs"
ALTER COLUMN "idempotency_key" SET NOT NULL,
ALTER COLUMN "request_hash" SET NOT NULL,
ALTER COLUMN "timezone" SET NOT NULL,
ALTER COLUMN "consent_epoch" SET NOT NULL,
ALTER COLUMN "server_sequence" SET NOT NULL,
ALTER COLUMN "server_sequence" SET DEFAULT nextval('health_sync_server_sequence'),
ADD CONSTRAINT "health_sync_runs_anchor_epoch_nonnegative" CHECK ("anchor_epoch" >= 0),
ADD CONSTRAINT "health_sync_runs_consent_epoch_nonnegative" CHECK ("consent_epoch" >= 0),
ADD CONSTRAINT "health_sync_runs_server_sequence_positive" CHECK ("server_sequence" > 0);

CREATE UNIQUE INDEX "health_sync_runs_user_id_idempotency_key_key"
ON "health_sync_runs"("user_id", "idempotency_key");
CREATE UNIQUE INDEX "health_sync_runs_server_sequence_key"
ON "health_sync_runs"("server_sequence");

CREATE UNIQUE INDEX "devices_one_primary_health_device_per_user"
ON "devices"("user_id")
WHERE "is_primary_health_device" = TRUE;

ALTER TABLE "daily_health_fact_revisions"
ADD COLUMN "health_sync_run_id" UUID,
ADD COLUMN "server_sequence" BIGINT,
ADD CONSTRAINT "daily_health_fact_revisions_metric_known" CHECK (
  "metric" IN (
    'steps', 'active_energy_kcal', 'exercise_minutes', 'sleep_minutes',
    'resting_heart_rate_bpm', 'hrv_ms', 'workout_minutes', 'weight_kg', 'vo2_max'
  )
) NOT VALID,
ADD CONSTRAINT "daily_health_fact_revisions_server_sequence_positive"
CHECK ("server_sequence" IS NULL OR "server_sequence" > 0);

ALTER TABLE "daily_health_fact_revisions"
ADD CONSTRAINT "daily_health_fact_revisions_health_sync_run_id_fkey"
FOREIGN KEY ("health_sync_run_id") REFERENCES "health_sync_runs"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "daily_fact_current_sequence_idx"
ON "daily_health_fact_revisions"("user_id", "local_date", "metric", "server_sequence");

ALTER TABLE "domain_outbox"
ADD COLUMN "lease_token" TEXT;

DROP VIEW "current_daily_health_facts";

CREATE VIEW "current_daily_health_facts" AS
SELECT DISTINCT ON ("user_id", "local_date", "metric")
  "id", "user_id", "local_date", "metric", "canonical_value_json",
  "coverage", "source_vector_json", "input_hash", "supersedes_id",
  "health_sync_run_id", "server_sequence", "created_at"
FROM "daily_health_fact_revisions"
ORDER BY
  "user_id", "local_date", "metric",
  "server_sequence" DESC NULLS LAST,
  "created_at" DESC,
  "id" DESC;
