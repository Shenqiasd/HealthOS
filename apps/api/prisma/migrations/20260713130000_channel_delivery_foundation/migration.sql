ALTER TABLE "devices"
ADD COLUMN "apns_token_epoch" INTEGER NOT NULL DEFAULT 0;

WITH ranked_device_tokens AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "apns_token_fingerprint"
      ORDER BY "updated_at" DESC, "last_seen_at" DESC NULLS LAST, "id" DESC
    ) AS ownership_rank
  FROM "devices"
  WHERE "apns_token_fingerprint" IS NOT NULL
)
UPDATE "devices" device
SET
  "apns_token_encrypted" = NULL,
  "apns_token_fingerprint" = NULL,
  "updated_at" = statement_timestamp()
FROM ranked_device_tokens ranked
WHERE device."id" = ranked."id"
  AND ranked.ownership_rank > 1;

UPDATE "devices"
SET "apns_token_epoch" = 1
WHERE "apns_token_fingerprint" IS NOT NULL;

ALTER TABLE "devices"
ADD CONSTRAINT "devices_apns_token_epoch_nonnegative"
CHECK ("apns_token_epoch" >= 0);

DROP INDEX "devices_apns_token_fingerprint_idx";
CREATE UNIQUE INDEX "devices_apns_token_fingerprint_key"
ON "devices"("apns_token_fingerprint");

CREATE FUNCTION "healthos_claim_apns_token"(
  target_user_id UUID,
  target_device_id TEXT,
  token_ciphertext TEXT,
  token_fingerprint TEXT,
  target_app_version TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  target_epoch INTEGER;
  current_epoch INTEGER;
  current_fingerprint TEXT;
  lock_key BIGINT;
BEGIN
  IF target_user_id IS NULL
    OR length(btrim(target_device_id)) NOT BETWEEN 1 AND 128
    OR length(btrim(token_ciphertext)) NOT BETWEEN 1 AND 8192
    OR token_fingerprint !~ '^[a-f0-9]{64}$'
    OR length(btrim(target_app_version)) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'Invalid APNs token ownership claim';
  END IF;

  PERFORM 1 FROM "users"
  WHERE "id" = target_user_id AND "status" = 'active'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'APNs token owner must be active';
  END IF;

  FOR lock_key IN
    SELECT DISTINCT candidate
    FROM unnest(ARRAY[
      hashtextextended('apns-token:' || token_fingerprint, 0),
      hashtextextended('apns-device:' || target_user_id::text || ':' || target_device_id, 0)
    ]) AS lock_candidates(candidate)
    ORDER BY candidate
  LOOP
    PERFORM pg_advisory_xact_lock(lock_key);
  END LOOP;

  PERFORM "id"
  FROM "devices"
  WHERE ("user_id" = target_user_id AND "device_id" = target_device_id)
     OR "apns_token_fingerprint" = token_fingerprint
  ORDER BY "id"
  FOR UPDATE;

  SELECT "apns_token_epoch", "apns_token_fingerprint"
  INTO current_epoch, current_fingerprint
  FROM "devices"
  WHERE "user_id" = target_user_id AND "device_id" = target_device_id;

  target_epoch := CASE
    WHEN current_fingerprint = token_fingerprint THEN greatest(current_epoch, 1)
    ELSE coalesce(current_epoch, 0) + 1
  END;

  UPDATE "devices"
  SET
    "apns_token_encrypted" = NULL,
    "apns_token_fingerprint" = NULL,
    "updated_at" = statement_timestamp()
  WHERE "apns_token_fingerprint" = token_fingerprint
    AND ("user_id" <> target_user_id OR "device_id" <> target_device_id);

  INSERT INTO "devices"(
    "user_id",
    "device_id",
    "apns_token_encrypted",
    "apns_token_fingerprint",
    "apns_token_epoch",
    "last_seen_at",
    "app_version",
    "updated_at"
  ) VALUES (
    target_user_id,
    target_device_id,
    token_ciphertext,
    token_fingerprint,
    target_epoch,
    statement_timestamp(),
    target_app_version,
    statement_timestamp()
  )
  ON CONFLICT ("user_id", "device_id") DO UPDATE SET
    "apns_token_encrypted" = EXCLUDED."apns_token_encrypted",
    "apns_token_fingerprint" = EXCLUDED."apns_token_fingerprint",
    "apns_token_epoch" = EXCLUDED."apns_token_epoch",
    "last_seen_at" = EXCLUDED."last_seen_at",
    "app_version" = EXCLUDED."app_version",
    "updated_at" = EXCLUDED."updated_at";

  RETURN target_epoch;
END;
$$;

ALTER TABLE "channel_outbox"
  ADD COLUMN "destination_id" UUID,
  ADD COLUMN "destination_fingerprint" TEXT,
  ADD COLUMN "destination_epoch" INTEGER,
  ADD COLUMN "destination_tenant_id" TEXT,
  ADD COLUMN "schedule_plan_id" UUID;

CREATE UNIQUE INDEX "channel_outbox_schedule_plan_id_channel_key"
ON "channel_outbox"("schedule_plan_id", "channel");

ALTER TABLE "channel_outbox"
ADD CONSTRAINT "channel_outbox_schedule_plan_id_fkey"
FOREIGN KEY ("schedule_plan_id") REFERENCES "schedule_plans"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "channel_outbox"
ADD CONSTRAINT "channel_outbox_known_channel"
CHECK ("channel" IN ('in_app', 'internal', 'apns', 'wecom')) NOT VALID;

ALTER TABLE "channel_outbox"
ADD CONSTRAINT "channel_outbox_payload_object"
CHECK (jsonb_typeof("payload") = 'object') NOT VALID;

ALTER TABLE "channel_outbox"
ADD CONSTRAINT "channel_outbox_external_destination_shape"
CHECK (
  (
    "channel" = 'in_app'
    AND "destination_id" IS NULL
    AND "destination_fingerprint" IS NULL
    AND "destination_epoch" IS NULL
    AND "destination_tenant_id" IS NULL
    AND "schedule_plan_id" IS NULL
  )
  OR (
    "channel" = 'internal'
    AND "destination_id" IS NULL
    AND "destination_fingerprint" IS NULL
    AND "destination_epoch" IS NULL
    AND "destination_tenant_id" IS NULL
    AND "schedule_plan_id" IS NULL
  )
  OR (
    "channel" = 'apns'
    AND "destination_id" IS NOT NULL
    AND "destination_fingerprint" ~ '^[a-f0-9]{64}$'
    AND "destination_epoch" > 0
    AND "destination_tenant_id" IS NULL
    AND "schedule_plan_id" IS NOT NULL
  )
  OR (
    "channel" = 'wecom'
    AND "destination_id" IS NOT NULL
    AND "destination_fingerprint" ~ '^[a-f0-9]{64}$'
    AND "destination_epoch" > 0
    AND length(btrim("destination_tenant_id")) BETWEEN 1 AND 128
    AND "schedule_plan_id" IS NOT NULL
  )
  OR (
    "channel" IN ('apns', 'wecom')
    AND "destination_id" IS NULL
    AND "destination_fingerprint" IS NULL
    AND "destination_epoch" IS NULL
    AND "destination_tenant_id" IS NULL
    AND "schedule_plan_id" IS NULL
  )
) NOT VALID;

ALTER TABLE "channel_outbox"
ADD CONSTRAINT "channel_outbox_allowlisted_template"
CHECK (
  ("channel" = 'in_app' AND "template" = 'recommendation_snapshot')
  OR (
    "channel" = 'internal'
    AND "template" = 'projection_ready'
    AND "payload" ? 'template_data'
    AND "payload" - 'template_data' = '{}'::jsonb
  )
  OR (
    "channel" IN ('apns', 'wecom')
    AND (
      (
        "template" = 'daily_advisor_v1'
        AND "payload" = '{
          "schema_version": 1,
          "template": "daily_advisor_v1",
          "copy_key": "notification.daily_advisor",
          "action_key": "open_today",
          "deeplink_path": "/today"
        }'::jsonb
      )
      OR (
        "template" = 'behavior_reminder_v1'
        AND "payload" = '{
          "schema_version": 1,
          "template": "behavior_reminder_v1",
          "copy_key": "notification.behavior_reminder",
          "action_key": "open_today",
          "deeplink_path": "/today"
        }'::jsonb
      )
      OR (
        "template" = 'weekly_review_v1'
        AND "payload" = '{
          "schema_version": 1,
          "template": "weekly_review_v1",
          "copy_key": "notification.weekly_review",
          "action_key": "open_review",
          "deeplink_path": "/review"
        }'::jsonb
      )
    )
  )
  OR (
    "channel" IN ('apns', 'wecom')
    AND "destination_id" IS NULL
    AND "template" = 'daily_ready'
    AND "payload" ? 'template_data'
    AND "payload" - 'template_data' = '{}'::jsonb
  )
) NOT VALID;

ALTER TABLE "delivery_attempts"
ADD CONSTRAINT "delivery_attempts_positive_attempt"
CHECK ("attempt" > 0) NOT VALID;

ALTER TABLE "delivery_attempts"
ADD CONSTRAINT "delivery_attempts_evidence_shape"
CHECK (
  (
    "status" = 'sent'
    AND "provider_message_id" IS NOT NULL
    AND "sent_at" IS NOT NULL
    AND "error_code" IS NULL
  )
  OR (
    "status" IN ('pending', 'failed', 'unknown_after_send')
    AND "error_code" ~ '^[a-z0-9_]{1,64}$'
    AND ("status" <> 'unknown_after_send' OR "sent_at" IS NOT NULL)
  )
) NOT VALID;

CREATE FUNCTION "healthos_validate_channel_outbox_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."user_id" IS DISTINCT FROM NEW."user_id"
     OR OLD."channel" IS DISTINCT FROM NEW."channel"
     OR OLD."template" IS DISTINCT FROM NEW."template"
     OR OLD."payload" IS DISTINCT FROM NEW."payload"
     OR OLD."idempotency_key" IS DISTINCT FROM NEW."idempotency_key"
     OR OLD."destination_id" IS DISTINCT FROM NEW."destination_id"
     OR OLD."destination_fingerprint" IS DISTINCT FROM NEW."destination_fingerprint"
     OR OLD."destination_epoch" IS DISTINCT FROM NEW."destination_epoch"
     OR OLD."destination_tenant_id" IS DISTINCT FROM NEW."destination_tenant_id"
     OR OLD."schedule_plan_id" IS DISTINCT FROM NEW."schedule_plan_id" THEN
    RAISE EXCEPTION 'Channel outbox identity and payload are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD."status" IS DISTINCT FROM NEW."status"
     AND NOT (
       (OLD."status" = 'pending' AND NEW."status" IN ('leased', 'suppressed'))
       OR (OLD."status" = 'leased' AND NEW."status" IN (
         'pending', 'sent', 'failed', 'suppressed', 'unknown_after_send'
       ))
     ) THEN
    RAISE EXCEPTION 'Invalid channel outbox transition: % -> %', OLD."status", NEW."status"
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status" = 'leased'
     AND NEW."status" = 'leased'
     AND (
       OLD."lease_token" IS DISTINCT FROM NEW."lease_token"
       OR OLD."lease_until" IS DISTINCT FROM NEW."lease_until"
     ) THEN
    RAISE EXCEPTION 'Active channel lease cannot be replaced or renewed'
      USING ERRCODE = '55000';
  END IF;

  IF OLD."status" = 'leased'
     AND NEW."status" IN ('pending', 'sent', 'failed', 'unknown_after_send')
     AND current_setting('healthos.channel_lease_token', true) IS DISTINCT FROM OLD."lease_token" THEN
    RAISE EXCEPTION 'Channel outbox terminal transition requires the current lease token'
      USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'leased'
     AND NEW."status" = 'suppressed'
     AND current_setting('healthos.channel_lease_token', true) IS DISTINCT FROM OLD."lease_token"
     AND EXISTS (
       SELECT 1
       FROM "users" u
       JOIN "privacy_reconciliation" pr ON pr."id" = 'global' AND pr."status" = 'ready'
       JOIN "schedule_plans" sp
         ON sp."id" = OLD."schedule_plan_id"
        AND sp."user_id" = OLD."user_id"
        AND sp."status" = 'planned'
        AND sp."cutoff_at" >= statement_timestamp()
       JOIN "reminder_preferences" rp
         ON rp."user_id" = OLD."user_id"
        AND rp."enabled" = true
        AND rp."version" = sp."preference_version"
       WHERE u."id" = OLD."user_id"
         AND u."status" = 'active'
         AND OLD."lease_until" > statement_timestamp()
         AND (
           (
             OLD."channel" = 'apns'
             AND EXISTS (
               SELECT 1 FROM "devices" d
               WHERE d."id" = OLD."destination_id"
                 AND d."user_id" = OLD."user_id"
                 AND d."apns_token_encrypted" IS NOT NULL
                 AND d."apns_token_fingerprint" = OLD."destination_fingerprint"
                 AND d."apns_token_epoch" = OLD."destination_epoch"
             )
           )
           OR (
             OLD."channel" = 'wecom'
             AND EXISTS (
               SELECT 1 FROM "channel_accounts" ca
               WHERE ca."id" = OLD."destination_id"
                 AND ca."user_id" = OLD."user_id"
                 AND ca."channel" = 'wecom'
                 AND ca."status" = 'linked'
                 AND ca."tenant_id" = OLD."destination_tenant_id"
                 AND ca."external_id_lookup_hmac" = OLD."destination_fingerprint"
                 AND ca."consent_epoch" = OLD."destination_epoch"
             )
           )
         )
         AND (
           SELECT count(*) FROM "channel_outbox_consent_requirements" req
           WHERE req."outbox_id" = OLD."id" AND req."purpose" = 'notifications'
         ) = 1
         AND EXISTS (
           SELECT 1
           FROM "channel_outbox_consent_requirements" req
           JOIN LATERAL (
             SELECT c."granted", c."epoch"
             FROM "consent_records" c
             WHERE c."user_id" = OLD."user_id"
               AND c."consent_type" = 'notifications'
             ORDER BY c."epoch" DESC
             LIMIT 1
           ) current_consent ON true
           WHERE req."outbox_id" = OLD."id"
             AND req."purpose" = 'notifications'
             AND current_consent."granted" = true
             AND current_consent."epoch" = req."grant_epoch"
         )
     ) THEN
    RAISE EXCEPTION 'Channel suppression requires the current lease token while delivery remains authorized'
      USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'leased'
     AND NEW."status" = 'sent'
     AND (OLD."lease_until" IS NULL OR OLD."lease_until" <= statement_timestamp()) THEN
    RAISE EXCEPTION 'Expired channel lease cannot commit a sent delivery'
      USING ERRCODE = '55000';
  END IF;

  IF NEW."status" = 'leased' THEN
    IF NEW."lease_token" IS NULL OR NEW."lease_until" IS NULL THEN
      RAISE EXCEPTION 'Leased channel outbox requires a complete lease'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    NEW."lease_token" := NULL;
    NEW."lease_until" := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "channel_outbox_validate_update"
BEFORE UPDATE ON "channel_outbox"
FOR EACH ROW EXECUTE FUNCTION "healthos_validate_channel_outbox_update"();

CREATE FUNCTION "healthos_prevent_channel_delivery_evidence_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  evidence_user_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT o."user_id" INTO evidence_user_id
    FROM "channel_outbox" o WHERE o."id" = OLD."outbox_id";
    IF evidence_user_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM "healthos_private"."privacy_delete_authorizations"
      WHERE "transaction_id" = txid_current() AND "user_id" = evidence_user_id
    ) THEN RETURN OLD; END IF;
  END IF;
  RAISE EXCEPTION '% is append-only; create a new delivery event', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "channel_outbox_consent_requirements_append_only"
BEFORE UPDATE OR DELETE ON "channel_outbox_consent_requirements"
FOR EACH ROW EXECUTE FUNCTION "healthos_prevent_channel_delivery_evidence_mutation"();

CREATE TRIGGER "delivery_attempts_append_only"
BEFORE UPDATE OR DELETE ON "delivery_attempts"
FOR EACH ROW EXECUTE FUNCTION "healthos_prevent_channel_delivery_evidence_mutation"();

CREATE OR REPLACE FUNCTION "healthos_delete_frozen_user"(target_user_id UUID)
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

  INSERT INTO "healthos_private"."privacy_delete_authorizations" (
    "transaction_id", "user_id"
  ) VALUES (txid_current(), target_user_id)
  ON CONFLICT DO NOTHING;
  DELETE FROM "delivery_attempts"
  WHERE "outbox_id" IN (
    SELECT "id" FROM "channel_outbox" WHERE "user_id" = target_user_id
  );
  DELETE FROM "channel_outbox_consent_requirements"
  WHERE "outbox_id" IN (
    SELECT "id" FROM "channel_outbox" WHERE "user_id" = target_user_id
  );
  DELETE FROM "recommendation_run_fact_inputs"
  WHERE "run_id" IN (
    SELECT "id" FROM "recommendation_runs" WHERE "user_id" = target_user_id
  );
  DELETE FROM "recommendation_run_lab_inputs"
  WHERE "run_id" IN (
    SELECT "id" FROM "recommendation_runs" WHERE "user_id" = target_user_id
  );
  DELETE FROM "security_events" WHERE "user_id" = target_user_id;
  DELETE FROM "users" WHERE "id" = target_user_id;
  DELETE FROM "healthos_private"."privacy_delete_authorizations"
  WHERE "transaction_id" = txid_current() AND "user_id" = target_user_id;
  RETURN TRUE;
END;
$$;

ALTER TABLE "channel_outbox" VALIDATE CONSTRAINT "channel_outbox_known_channel";
ALTER TABLE "channel_outbox" VALIDATE CONSTRAINT "channel_outbox_payload_object";
ALTER TABLE "channel_outbox" VALIDATE CONSTRAINT "channel_outbox_external_destination_shape";
ALTER TABLE "channel_outbox" VALIDATE CONSTRAINT "channel_outbox_allowlisted_template";
ALTER TABLE "delivery_attempts" VALIDATE CONSTRAINT "delivery_attempts_positive_attempt";
ALTER TABLE "delivery_attempts" VALIDATE CONSTRAINT "delivery_attempts_evidence_shape";
