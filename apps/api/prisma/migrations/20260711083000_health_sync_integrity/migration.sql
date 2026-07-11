ALTER TABLE "health_sync_runs"
ADD CONSTRAINT "health_sync_runs_completion_consistent"
CHECK (
  ("status" = 'completed' AND "completed_at" IS NOT NULL)
  OR ("status" <> 'completed' AND "completed_at" IS NULL)
) NOT VALID;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "health_sync_runs"
    WHERE ("status" = 'completed' AND "completed_at" IS NULL)
       OR ("status" <> 'completed' AND "completed_at" IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Historical health sync completion evidence is inconsistent; resolve before migration';
  END IF;
END;
$$;

ALTER TABLE "health_sync_runs"
VALIDATE CONSTRAINT "health_sync_runs_completion_consistent";

CREATE FUNCTION "healthos_protect_health_sync_run"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1
      FROM "healthos_private"."privacy_delete_authorizations"
      WHERE "transaction_id" = txid_current()
        AND "user_id" = OLD."user_id"
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Health sync identity is immutable outside an exact privacy-delete transaction';
  END IF;

  IF OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."user_id" IS DISTINCT FROM NEW."user_id"
    OR OLD."device_id" IS DISTINCT FROM NEW."device_id"
    OR OLD."anchor_epoch" IS DISTINCT FROM NEW."anchor_epoch"
    OR OLD."idempotency_key" IS DISTINCT FROM NEW."idempotency_key"
    OR OLD."request_hash" IS DISTINCT FROM NEW."request_hash"
    OR OLD."timezone" IS DISTINCT FROM NEW."timezone"
    OR OLD."consent_epoch" IS DISTINCT FROM NEW."consent_epoch"
    OR OLD."server_sequence" IS DISTINCT FROM NEW."server_sequence"
    OR OLD."started_at" IS DISTINCT FROM NEW."started_at"
    OR OLD."correlation_id" IS DISTINCT FROM NEW."correlation_id" THEN
    RAISE EXCEPTION 'Health sync identity is immutable';
  END IF;

  IF OLD."status" = NEW."status"
    AND OLD."completed_at" IS NOT DISTINCT FROM NEW."completed_at" THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'pending'
    AND OLD."completed_at" IS NULL
    AND NEW."status" = 'completed'
    AND NEW."completed_at" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Invalid health sync transition: % -> %', OLD."status", NEW."status";
END;
$$;

CREATE TRIGGER "health_sync_runs_identity_immutable"
BEFORE UPDATE OR DELETE ON "health_sync_runs"
FOR EACH ROW EXECUTE FUNCTION "healthos_protect_health_sync_run"();
