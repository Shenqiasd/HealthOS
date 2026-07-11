CREATE TYPE "profile_candidate_status" AS ENUM ('pending', 'confirmed', 'rejected');

CREATE SEQUENCE "profile_event_sequence" START WITH 1 INCREMENT BY 1;

CREATE OR REPLACE FUNCTION "healthos_canonical_jsonb"(input JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  output TEXT;
BEGIN
  CASE jsonb_typeof(input)
    WHEN 'object' THEN
      SELECT '{' || COALESCE(string_agg(
        to_jsonb(entry.key)::TEXT || ':' || "healthos_canonical_jsonb"(entry.value),
        ',' ORDER BY entry.key
      ), '') || '}'
      INTO output
      FROM jsonb_each(input) AS entry;
    WHEN 'array' THEN
      SELECT '[' || COALESCE(string_agg(
        "healthos_canonical_jsonb"(item.value),
        ',' ORDER BY item.ordinality
      ), '') || ']'
      INTO output
      FROM jsonb_array_elements(input) WITH ORDINALITY AS item(value, ordinality);
    ELSE
      output := input::TEXT;
  END CASE;
  RETURN output;
END;
$$;

ALTER TABLE "profile_events"
ADD COLUMN "sequence" BIGINT,
ADD COLUMN "consent_epoch" INTEGER,
ADD COLUMN "payload_hash" TEXT;

ALTER TABLE "profile_events"
DISABLE TRIGGER "profile_events_append_only";

WITH ordered AS (
  SELECT "id", row_number() OVER (ORDER BY "occurred_at", "id") AS ordinal
  FROM "profile_events"
)
UPDATE "profile_events" AS event
SET
  "sequence" = ordered.ordinal,
  "consent_epoch" = 0,
  "payload_hash" = encode(sha256(convert_to("healthos_canonical_jsonb"(
    jsonb_build_object(
      'event_type', event."event_type",
      'occurred_at', NULL,
      'payload', event."payload",
      'source', event."source"
    )
  ), 'UTF8')), 'hex')
FROM ordered
WHERE event."id" = ordered."id";

ALTER TABLE "profile_events"
ENABLE TRIGGER "profile_events_append_only";

DO $$
DECLARE
  last_sequence BIGINT;
BEGIN
  SELECT max("sequence") INTO last_sequence FROM "profile_events";
  IF last_sequence IS NULL THEN
    PERFORM setval('profile_event_sequence', 1, false);
  ELSE
    PERFORM setval('profile_event_sequence', last_sequence, true);
  END IF;
END;
$$;

ALTER TABLE "profile_events"
ALTER COLUMN "sequence" SET NOT NULL,
ALTER COLUMN "sequence" SET DEFAULT nextval('profile_event_sequence'),
ALTER COLUMN "consent_epoch" SET NOT NULL,
ALTER COLUMN "consent_epoch" SET DEFAULT 0,
ALTER COLUMN "payload_hash" SET NOT NULL,
ALTER COLUMN "payload_hash" SET DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
ADD CONSTRAINT "profile_events_sequence_positive" CHECK ("sequence" > 0),
ADD CONSTRAINT "profile_events_consent_epoch_nonnegative" CHECK ("consent_epoch" >= 0),
ADD CONSTRAINT "profile_events_payload_hash_sha256" CHECK (length("payload_hash") = 64),
ADD CONSTRAINT "profile_events_event_type_allowlist" CHECK (
  "event_type" IN (
    'daily_health_facts_accepted', 'lab_value_corrected', 'limitation_confirmed',
    'synthetic_profile_created'
  )
);

ALTER SEQUENCE "profile_event_sequence" OWNED BY "profile_events"."sequence";

CREATE UNIQUE INDEX "profile_events_sequence_key"
ON "profile_events"("sequence");

CREATE UNIQUE INDEX "profile_events_user_id_correlation_id_key"
ON "profile_events"("user_id", "correlation_id");

CREATE UNIQUE INDEX "profile_events_id_user_id_key"
ON "profile_events"("id", "user_id");

CREATE UNIQUE INDEX "profile_events_id_user_id_sequence_key"
ON "profile_events"("id", "user_id", "sequence");

CREATE INDEX "profile_events_user_id_sequence_idx"
ON "profile_events"("user_id", "sequence");

CREATE INDEX "profile_events_user_id_occurred_at_sequence_idx"
ON "profile_events"("user_id", "occurred_at", "sequence");

CREATE OR REPLACE FUNCTION "healthos_fill_profile_event_defaults"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."payload_hash" = repeat('0', 64) THEN
    NEW."payload_hash" := encode(sha256(convert_to("healthos_canonical_jsonb"(
      jsonb_build_object(
        'event_type', NEW."event_type",
        'occurred_at', NULL,
        'payload', NEW."payload",
        'source', NEW."source"
      )
    ), 'UTF8')), 'hex');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "profile_events_fill_defaults"
BEFORE INSERT ON "profile_events"
FOR EACH ROW EXECUTE FUNCTION "healthos_fill_profile_event_defaults"();

ALTER TABLE "profile_snapshots"
ADD COLUMN "source_sequence" BIGINT,
ADD COLUMN "consent_epoch" INTEGER,
ADD COLUMN "snapshot_hash" TEXT;

ALTER TABLE "profile_snapshots"
DISABLE TRIGGER "profile_snapshots_append_only";

UPDATE "profile_snapshots" AS snapshot
SET
  "source_sequence" = event."sequence",
  "consent_epoch" = event."consent_epoch",
  "snapshot_hash" = encode(sha256(convert_to("healthos_canonical_jsonb"(
    jsonb_build_object(
      'consent_epoch', event."consent_epoch",
      'facts', snapshot."facts_json",
      'source_sequence', event."sequence"::TEXT,
      'version', snapshot."version"
    )
  ), 'UTF8')), 'hex')
FROM "profile_events" AS event
WHERE event."id" = snapshot."source_event_until"
  AND event."user_id" = snapshot."user_id";

ALTER TABLE "profile_snapshots"
ENABLE TRIGGER "profile_snapshots_append_only";

ALTER TABLE "profile_snapshots"
ALTER COLUMN "source_sequence" SET NOT NULL,
ALTER COLUMN "source_sequence" SET DEFAULT 0,
ALTER COLUMN "consent_epoch" SET NOT NULL,
ALTER COLUMN "consent_epoch" SET DEFAULT 0,
ALTER COLUMN "snapshot_hash" SET NOT NULL,
ALTER COLUMN "snapshot_hash" SET DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
ADD CONSTRAINT "profile_snapshots_source_sequence_positive" CHECK ("source_sequence" > 0),
ADD CONSTRAINT "profile_snapshots_consent_epoch_nonnegative" CHECK ("consent_epoch" >= 0),
ADD CONSTRAINT "profile_snapshots_snapshot_hash_sha256" CHECK (length("snapshot_hash") = 64),
ADD CONSTRAINT "profile_snapshots_version_positive" CHECK ("version" > 0);

CREATE UNIQUE INDEX "profile_snapshots_user_id_source_sequence_key"
ON "profile_snapshots"("user_id", "source_sequence");

CREATE OR REPLACE FUNCTION "healthos_fill_profile_snapshot_defaults"()
RETURNS TRIGGER AS $$
DECLARE
  source_sequence_value BIGINT;
  source_consent_epoch INTEGER;
BEGIN
  SELECT "sequence", "consent_epoch"
  INTO source_sequence_value, source_consent_epoch
  FROM "profile_events"
  WHERE "id" = NEW."source_event_until" AND "user_id" = NEW."user_id";
  IF source_sequence_value IS NULL THEN
    RAISE EXCEPTION 'profile snapshot source event is invalid' USING ERRCODE = '23503';
  END IF;
  IF NEW."source_sequence" = 0 THEN
    NEW."source_sequence" := source_sequence_value;
  END IF;
  IF NEW."consent_epoch" = 0 THEN
    NEW."consent_epoch" := source_consent_epoch;
  END IF;
  IF NEW."snapshot_hash" = repeat('0', 64) THEN
    NEW."snapshot_hash" := encode(sha256(convert_to("healthos_canonical_jsonb"(
      jsonb_build_object(
        'consent_epoch', NEW."consent_epoch",
        'facts', NEW."facts_json",
        'source_sequence', NEW."source_sequence"::TEXT,
        'version', NEW."version"
      )
    ), 'UTF8')), 'hex');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "profile_snapshots_fill_defaults"
BEFORE INSERT ON "profile_snapshots"
FOR EACH ROW EXECUTE FUNCTION "healthos_fill_profile_snapshot_defaults"();

ALTER TABLE "profile_snapshots"
DROP CONSTRAINT "profile_snapshots_source_event_until_fkey";

ALTER TABLE "profile_snapshots"
ADD CONSTRAINT "profile_snapshots_source_provenance_fkey"
FOREIGN KEY ("source_event_until", "user_id", "source_sequence")
REFERENCES "profile_events"("id", "user_id", "sequence")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "profile_candidates" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "candidate_type" TEXT NOT NULL,
  "structured_value_json" JSONB NOT NULL,
  "source_text_hash" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "status" "profile_candidate_status" NOT NULL DEFAULT 'pending',
  "confirmed_event_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmed_at" TIMESTAMPTZ(6),

  CONSTRAINT "profile_candidates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "profile_candidates_source_text_hash_length" CHECK (length("source_text_hash") = 64),
  CONSTRAINT "profile_candidates_request_hash_length" CHECK (length("request_hash") = 64)
);

CREATE UNIQUE INDEX "profile_candidates_user_id_idempotency_key_key"
ON "profile_candidates"("user_id", "idempotency_key");

CREATE UNIQUE INDEX "profile_candidates_confirmed_event_id_key"
ON "profile_candidates"("confirmed_event_id");

CREATE UNIQUE INDEX "profile_candidates_confirmed_event_id_user_id_key"
ON "profile_candidates"("confirmed_event_id", "user_id");

CREATE INDEX "profile_candidates_user_id_status_created_at_idx"
ON "profile_candidates"("user_id", "status", "created_at");

ALTER TABLE "profile_candidates"
ADD CONSTRAINT "profile_candidates_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "profile_candidates"
ADD CONSTRAINT "profile_candidates_confirmed_event_id_fkey"
FOREIGN KEY ("confirmed_event_id", "user_id") REFERENCES "profile_events"("id", "user_id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE SCHEMA IF NOT EXISTS "healthos_private";
REVOKE ALL ON SCHEMA "healthos_private" FROM PUBLIC;

CREATE TABLE "healthos_private"."privacy_delete_authorizations" (
  "transaction_id" BIGINT NOT NULL,
  "user_id" UUID NOT NULL,
  PRIMARY KEY ("transaction_id", "user_id")
);
REVOKE ALL ON TABLE "healthos_private"."privacy_delete_authorizations" FROM PUBLIC;

CREATE OR REPLACE FUNCTION "healthos_prevent_append_only_mutation"()
RETURNS TRIGGER AS $$
DECLARE
  row_user_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_user_id := NULLIF(to_jsonb(OLD)->>'user_id', '')::UUID;
    IF EXISTS (
      SELECT 1
      FROM "healthos_private"."privacy_delete_authorizations"
      WHERE "transaction_id" = txid_current()
        AND (row_user_id IS NULL OR "user_id" = row_user_id)
    ) THEN
      RETURN OLD;
    END IF;
    IF current_setting('healthos.allow_privacy_delete', true) = 'on'
      AND current_setting('role', true) IN ('', 'none')
      AND has_table_privilege(
        session_user,
        'healthos_private.privacy_delete_authorizations',
        'INSERT'
      ) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION '% is append-only; create a new revision or event', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

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
  DELETE FROM "security_events" WHERE "user_id" = target_user_id;
  DELETE FROM "users" WHERE "id" = target_user_id;
  DELETE FROM "healthos_private"."privacy_delete_authorizations"
  WHERE "transaction_id" = txid_current() AND "user_id" = target_user_id;
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION "healthos_delete_frozen_user"(UUID) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'healthos_privacy_worker') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION "healthos_delete_frozen_user"(UUID)'
      || ' TO "healthos_privacy_worker"';
  ELSE
    RAISE NOTICE 'healthos_privacy_worker role is not provisioned; DBA grant remains required';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "healthos_protect_profile_candidate"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."user_id" IS DISTINCT FROM NEW."user_id"
    OR OLD."candidate_type" IS DISTINCT FROM NEW."candidate_type"
    OR OLD."structured_value_json" IS DISTINCT FROM NEW."structured_value_json"
    OR OLD."source_text_hash" IS DISTINCT FROM NEW."source_text_hash"
    OR OLD."idempotency_key" IS DISTINCT FROM NEW."idempotency_key"
    OR OLD."request_hash" IS DISTINCT FROM NEW."request_hash"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'profile candidate content is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'pending'
    AND NEW."status" IN ('confirmed', 'rejected')
    AND (
      (NEW."status" = 'confirmed' AND NEW."confirmed_event_id" IS NOT NULL AND NEW."confirmed_at" IS NOT NULL)
      OR (NEW."status" = 'rejected' AND NEW."confirmed_event_id" IS NULL)
    ) THEN
    RETURN NEW;
  END IF;
  IF OLD IS NOT DISTINCT FROM NEW THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid profile candidate transition' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "profile_candidates_content_immutable"
BEFORE UPDATE ON "profile_candidates"
FOR EACH ROW EXECUTE FUNCTION "healthos_protect_profile_candidate"();
