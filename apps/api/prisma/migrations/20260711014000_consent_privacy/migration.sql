CREATE TYPE "export_job_status" AS ENUM (
  'requested', 'generating', 'ready', 'expired', 'failed_retryable'
);

CREATE TYPE "deletion_job_status" AS ENUM (
  'requested', 'frozen', 'deleting', 'completed', 'failed_retryable'
);

CREATE TYPE "privacy_reconciliation_status" AS ENUM (
  'required', 'running', 'ready', 'failed'
);

ALTER TABLE "users"
ADD COLUMN "consent_epoch" INTEGER NOT NULL DEFAULT 0,
ADD CONSTRAINT "users_consent_epoch_nonnegative" CHECK ("consent_epoch" >= 0);

ALTER TABLE "consent_records"
ADD COLUMN "epoch" INTEGER,
ADD COLUMN "correlation_id" TEXT,
ADD COLUMN "request_hash" TEXT;

WITH ranked_consents AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "user_id"
      ORDER BY "recorded_at", "id"
    )::INTEGER AS "derived_epoch"
  FROM "consent_records"
)
UPDATE "consent_records" AS consent
SET
  "epoch" = ranked."derived_epoch",
  "correlation_id" = 'migration:' || consent."id"::TEXT,
  "request_hash" = 'migration:' || consent."id"::TEXT
FROM ranked_consents AS ranked
WHERE consent."id" = ranked."id";

UPDATE "users" AS subject
SET "consent_epoch" = consent_max."max_epoch"
FROM (
  SELECT "user_id", MAX("epoch") AS "max_epoch"
  FROM "consent_records"
  GROUP BY "user_id"
) AS consent_max
WHERE subject."id" = consent_max."user_id";

ALTER TABLE "consent_records"
ALTER COLUMN "epoch" SET NOT NULL,
ALTER COLUMN "correlation_id" SET NOT NULL,
ALTER COLUMN "request_hash" SET NOT NULL,
ADD CONSTRAINT "consent_records_epoch_positive" CHECK ("epoch" > 0),
ADD CONSTRAINT "consent_records_known_purpose" CHECK (
  "consent_type" IN ('privacy_terms', 'health_processing', 'notifications', 'external_ai')
) NOT VALID,
ADD CONSTRAINT "consent_records_known_source" CHECK (
  "source" IN ('ios', 'admin', 'system', 'synthetic')
) NOT VALID;

CREATE UNIQUE INDEX "consent_records_user_id_epoch_key"
ON "consent_records"("user_id", "epoch");
CREATE UNIQUE INDEX "consent_records_user_id_correlation_id_key"
ON "consent_records"("user_id", "correlation_id");

CREATE TRIGGER "consent_records_append_only"
BEFORE UPDATE OR DELETE ON "consent_records"
FOR EACH ROW EXECUTE FUNCTION "healthos_prevent_append_only_mutation"();

ALTER TABLE "channel_outbox"
ADD COLUMN "lease_token" TEXT,
ADD COLUMN "lease_until" TIMESTAMPTZ(6);

CREATE TABLE "channel_outbox_consent_requirements" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "outbox_id" UUID NOT NULL,
  "purpose" TEXT NOT NULL,
  "grant_epoch" INTEGER NOT NULL,
  CONSTRAINT "channel_outbox_consent_requirements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "channel_outbox_consent_grant_epoch_positive" CHECK ("grant_epoch" > 0),
  CONSTRAINT "channel_outbox_consent_known_purpose" CHECK (
    "purpose" IN ('privacy_terms', 'health_processing', 'notifications', 'external_ai')
  )
);

CREATE UNIQUE INDEX "channel_outbox_consent_requirements_outbox_id_purpose_key"
ON "channel_outbox_consent_requirements"("outbox_id", "purpose");

ALTER TABLE "channel_outbox_consent_requirements"
ADD CONSTRAINT "channel_outbox_consent_requirements_outbox_id_fkey"
FOREIGN KEY ("outbox_id") REFERENCES "channel_outbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "domain_outbox"
ADD COLUMN "user_id" UUID;

ALTER TABLE "domain_outbox"
ADD CONSTRAINT "domain_outbox_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "domain_outbox_user_id_status_idx"
ON "domain_outbox"("user_id", "status");

CREATE TABLE "domain_outbox_consent_requirements" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "outbox_id" UUID NOT NULL,
  "purpose" TEXT NOT NULL,
  "grant_epoch" INTEGER NOT NULL,
  CONSTRAINT "domain_outbox_consent_requirements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "domain_outbox_consent_grant_epoch_positive" CHECK ("grant_epoch" > 0),
  CONSTRAINT "domain_outbox_consent_known_purpose" CHECK (
    "purpose" IN ('privacy_terms', 'health_processing', 'notifications', 'external_ai')
  )
);

CREATE UNIQUE INDEX "domain_outbox_consent_requirements_outbox_id_purpose_key"
ON "domain_outbox_consent_requirements"("outbox_id", "purpose");

ALTER TABLE "domain_outbox_consent_requirements"
ADD CONSTRAINT "domain_outbox_consent_requirements_outbox_id_fkey"
FOREIGN KEY ("outbox_id") REFERENCES "domain_outbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "export_jobs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "status" "export_job_status" NOT NULL DEFAULT 'requested',
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "object_key" TEXT,
  "artifact_sha256" TEXT,
  "expires_at" TIMESTAMPTZ(6),
  "lease_token" TEXT,
  "lease_until" TIMESTAMPTZ(6),
  "error_code" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "export_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "export_jobs_attempt_nonnegative" CHECK ("attempt" >= 0),
  CONSTRAINT "export_jobs_state_fields" CHECK (
    ("status" = 'ready' AND "object_key" IS NOT NULL AND "artifact_sha256" IS NOT NULL AND "expires_at" IS NOT NULL)
    OR ("status" = 'generating' AND "lease_token" IS NOT NULL AND "lease_until" IS NOT NULL)
    OR ("status" = 'failed_retryable' AND "error_code" IS NOT NULL)
    OR "status" IN ('requested', 'expired')
  )
);

CREATE UNIQUE INDEX "export_jobs_user_id_idempotency_key_key"
ON "export_jobs"("user_id", "idempotency_key");
CREATE INDEX "export_jobs_status_created_at_idx"
ON "export_jobs"("status", "created_at");

ALTER TABLE "export_jobs"
ADD CONSTRAINT "export_jobs_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "deletion_jobs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID,
  "user_lookup_hash" TEXT NOT NULL,
  "hash_key_version" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "status_token_hash" TEXT NOT NULL,
  "status" "deletion_job_status" NOT NULL DEFAULT 'requested',
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "lease_token" TEXT,
  "lease_until" TIMESTAMPTZ(6),
  "error_code" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(6),
  CONSTRAINT "deletion_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "deletion_jobs_attempt_nonnegative" CHECK ("attempt" >= 0),
  CONSTRAINT "deletion_jobs_state_fields" CHECK (
    ("status" = 'completed' AND "user_id" IS NULL AND "completed_at" IS NOT NULL)
    OR ("status" = 'failed_retryable' AND "user_id" IS NOT NULL AND "error_code" IS NOT NULL)
    OR ("status" = 'deleting' AND "user_id" IS NOT NULL AND "lease_token" IS NOT NULL AND "lease_until" IS NOT NULL)
    OR ("status" IN ('requested', 'frozen') AND "user_id" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "deletion_jobs_user_lookup_hash_key"
ON "deletion_jobs"("user_lookup_hash");
CREATE INDEX "deletion_jobs_status_updated_at_idx"
ON "deletion_jobs"("status", "updated_at");

CREATE TABLE "privacy_reconciliation" (
  "id" TEXT NOT NULL,
  "status" "privacy_reconciliation_status" NOT NULL DEFAULT 'required',
  "started_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "error_code" TEXT,
  "restore_run_id" TEXT,
  "backup_id" TEXT,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "privacy_reconciliation_pkey" PRIMARY KEY ("id")
);

INSERT INTO "privacy_reconciliation" ("id", "status")
VALUES ('global', 'required');

CREATE FUNCTION "healthos_enforce_export_job_transition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" = OLD."status" THEN RETURN NEW; END IF;
  IF (OLD."status" = 'requested' AND NEW."status" = 'generating')
     OR (OLD."status" = 'generating' AND NEW."status" IN ('ready', 'failed_retryable'))
     OR (OLD."status" = 'failed_retryable' AND NEW."status" = 'generating')
     OR (OLD."status" = 'ready' AND NEW."status" = 'expired') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid export job transition: % -> %', OLD."status", NEW."status"
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "export_jobs_state_transition"
BEFORE UPDATE ON "export_jobs"
FOR EACH ROW EXECUTE FUNCTION "healthos_enforce_export_job_transition"();

CREATE FUNCTION "healthos_enforce_deletion_job_transition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" = OLD."status" THEN RETURN NEW; END IF;
  IF (OLD."status" = 'requested' AND NEW."status" = 'frozen')
     OR (OLD."status" = 'frozen' AND NEW."status" = 'deleting')
     OR (OLD."status" = 'deleting' AND NEW."status" IN ('completed', 'failed_retryable'))
     OR (OLD."status" = 'failed_retryable' AND NEW."status" = 'deleting') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid deletion job transition: % -> %', OLD."status", NEW."status"
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "deletion_jobs_state_transition"
BEFORE UPDATE ON "deletion_jobs"
FOR EACH ROW EXECUTE FUNCTION "healthos_enforce_deletion_job_transition"();

CREATE FUNCTION "healthos_delete_frozen_user"(target_user_id UUID)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "users"
    WHERE "id" = target_user_id
      AND "status" = 'deleting'
      AND "deleted_at" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'user is not frozen for deletion' USING ERRCODE = '23514';
  END IF;

  PERFORM set_config('healthos.allow_privacy_delete', 'on', true);
  DELETE FROM "security_events" WHERE "user_id" = target_user_id;
  DELETE FROM "users" WHERE "id" = target_user_id;
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION "healthos_delete_frozen_user"(UUID) FROM PUBLIC;
