ALTER TABLE "action_assignments"
ADD COLUMN "action_code" TEXT,
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

UPDATE "action_assignments" assignment
SET "action_code" = snapshot."action_code"
FROM "recommendation_snapshots" snapshot
WHERE snapshot."id" = assignment."recommendation_snapshot_id";

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "action_assignments" WHERE "action_code" IS NULL) THEN
    RAISE EXCEPTION 'Existing action assignment has no snapshot action code';
  END IF;
END;
$$;

ALTER TABLE "action_assignments"
ADD CONSTRAINT "action_assignments_version_positive" CHECK ("version" > 0),
ADD CONSTRAINT "action_assignments_action_code_known" CHECK (
  "action_code" IN ('SLEEP_WIND_DOWN', 'SLEEP_WIND_DOWN_LIGHT', 'POST_MEAL_WALK', 'SUGARY_DRINK_SWAP')
),
ADD CONSTRAINT "action_assignments_replacement_shape" CHECK (
  ("status" = 'replaced' AND "replaced_by_id" IS NOT NULL)
  OR ("status" <> 'replaced' AND "replaced_by_id" IS NULL)
) NOT VALID;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "action_assignments"
    WHERE ("status" = 'replaced' AND "replaced_by_id" IS NULL)
       OR ("status" <> 'replaced' AND "replaced_by_id" IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Historical action replacement shape is inconsistent';
  END IF;
END;
$$;

ALTER TABLE "action_assignments"
VALIDATE CONSTRAINT "action_assignments_replacement_shape";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "action_assignments"
    GROUP BY "recommendation_snapshot_id", "action_code"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Historical action assignment repeats a snapshot action code';
  END IF;
END;
$$;

CREATE UNIQUE INDEX "action_assignments_recommendation_snapshot_id_action_code_key"
ON "action_assignments"("recommendation_snapshot_id", "action_code");

ALTER TABLE "feedback_events"
ADD COLUMN "user_id" UUID,
ADD COLUMN "idempotency_key" TEXT,
ADD COLUMN "request_hash" TEXT,
ADD COLUMN "result_json" JSONB;

UPDATE "feedback_events" feedback
SET
  "user_id" = assignment."user_id",
  "idempotency_key" = 'migration:' || feedback."id"::text,
  "request_hash" = encode(digest(jsonb_build_object(
    'type', feedback."type", 'reason_code', feedback."reason_code",
    'source', feedback."source", 'occurred_at', feedback."occurred_at"
  )::text, 'sha256'), 'hex'),
  "result_json" = jsonb_build_object('migrated_feedback_event_id', feedback."id")
FROM "action_assignments" assignment
WHERE assignment."id" = feedback."action_assignment_id";

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "feedback_events" WHERE "user_id" IS NULL) THEN
    RAISE EXCEPTION 'Historical feedback event has no owning action user';
  END IF;
END;
$$;

ALTER TABLE "feedback_events"
ALTER COLUMN "user_id" SET NOT NULL,
ALTER COLUMN "idempotency_key" SET NOT NULL,
ALTER COLUMN "request_hash" SET NOT NULL,
ALTER COLUMN "result_json" SET NOT NULL,
ADD CONSTRAINT "feedback_events_request_hash_sha256" CHECK ("request_hash" ~ '^[a-f0-9]{64}$'),
ADD CONSTRAINT "feedback_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "feedback_events_user_id_idempotency_key_key"
ON "feedback_events"("user_id", "idempotency_key");

CREATE UNIQUE INDEX "action_assignments_replaced_by_id_key"
ON "action_assignments"("replaced_by_id");

CREATE FUNCTION "healthos_validate_action_assignment"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  snapshot_user UUID;
  snapshot_date DATE;
  snapshot_action TEXT;
  snapshot_status "recommendation_review_status";
  replacement RECORD;
  expected_difficulty TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT run."user_id", run."local_date", snapshot."action_code", snapshot."review_status"
    INTO snapshot_user, snapshot_date, snapshot_action, snapshot_status
    FROM "recommendation_snapshots" snapshot
    JOIN "recommendation_runs" run ON run."id" = snapshot."run_id"
    WHERE snapshot."id" = NEW."recommendation_snapshot_id";
    IF snapshot_user IS NULL OR snapshot_user <> NEW."user_id" OR snapshot_date <> NEW."local_date"
      OR snapshot_status <> 'published' OR NEW."version" <> 1 OR NEW."replaced_by_id" IS NOT NULL
      OR NEW."status" NOT IN ('active', 'proposed') OR NEW."is_primary" IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'Action assignment provenance is invalid';
    END IF;
    IF NEW."action_code" IS NULL THEN NEW."action_code" := snapshot_action; END IF;
    IF NEW."action_code" IS NULL THEN RAISE EXCEPTION 'Action assignment code is required'; END IF;
    expected_difficulty := CASE NEW."action_code"
      WHEN 'SLEEP_WIND_DOWN' THEN 'standard'
      WHEN 'POST_MEAL_WALK' THEN 'standard'
      WHEN 'SLEEP_WIND_DOWN_LIGHT' THEN 'light'
      WHEN 'SUGARY_DRINK_SWAP' THEN 'light'
      ELSE NULL
    END;
    IF expected_difficulty IS NULL OR NEW."difficulty" <> expected_difficulty THEN
      RAISE EXCEPTION 'Action assignment difficulty does not match its catalog code';
    END IF;
    IF NEW."status" = 'active' AND NEW."action_code" <> snapshot_action THEN
      RAISE EXCEPTION 'Initial active assignment must match the published snapshot';
    END IF;
    IF NEW."status" = 'proposed' AND (
      NEW."action_code" = snapshot_action OR NOT EXISTS (
        SELECT 1 FROM "action_assignments" current
        WHERE current."user_id" = NEW."user_id"
          AND current."local_date" = NEW."local_date"
          AND current."recommendation_snapshot_id" = NEW."recommendation_snapshot_id"
          AND current."status" = 'active'
          AND current."is_primary" = TRUE
      )
    ) THEN
      RAISE EXCEPTION 'Replacement proposal requires a distinct current active action';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."action_code" IS DISTINCT FROM NEW."action_code" THEN
    RAISE EXCEPTION 'Action assignment code is immutable';
  END IF;
  IF OLD."status" = NEW."status" AND OLD."replaced_by_id" IS NOT DISTINCT FROM NEW."replaced_by_id" THEN
    IF OLD."version" IS DISTINCT FROM NEW."version" THEN
      RAISE EXCEPTION 'Action assignment version changes only with state';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'Action assignment version must advance exactly once';
  END IF;
  IF NOT (
    (OLD."status" = 'proposed' AND NEW."status" = 'active')
    OR (OLD."status" = 'active' AND NEW."status" IN ('completed', 'skipped', 'rejected', 'expired', 'replaced'))
  ) THEN
    RAISE EXCEPTION 'Invalid action assignment transition: % -> %', OLD."status", NEW."status";
  END IF;
  IF NEW."status" = 'replaced' THEN
    IF NEW."replaced_by_id" IS NULL THEN RAISE EXCEPTION 'Replacement target is required'; END IF;
    SELECT "user_id", "local_date", "recommendation_snapshot_id", "status", "is_primary"
    INTO replacement
    FROM "action_assignments"
    WHERE "id" = NEW."replaced_by_id";
    IF replacement IS NULL
      OR replacement."user_id" <> OLD."user_id"
      OR replacement."local_date" <> OLD."local_date"
      OR replacement."recommendation_snapshot_id" <> OLD."recommendation_snapshot_id"
      OR replacement."status" <> 'proposed'
      OR replacement."is_primary" IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'Replacement assignment provenance is invalid';
    END IF;
  ELSIF NEW."replaced_by_id" IS NOT NULL THEN
    RAISE EXCEPTION 'Only replaced actions may reference a replacement';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "action_assignments_state_machine"
BEFORE INSERT OR UPDATE ON "action_assignments"
FOR EACH ROW EXECUTE FUNCTION "healthos_validate_action_assignment"();

CREATE FUNCTION "healthos_validate_action_replacement_commit"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_assignment RECORD;
BEGIN
  SELECT assignment."status", assignment."action_code", snapshot."action_code" AS "snapshot_action"
  INTO current_assignment
  FROM "action_assignments" assignment
  JOIN "recommendation_snapshots" snapshot
    ON snapshot."id" = assignment."recommendation_snapshot_id"
  WHERE assignment."id" = NEW."id";

  IF current_assignment IS NULL THEN RETURN NULL; END IF;
  IF current_assignment."status" = 'proposed' THEN
    RAISE EXCEPTION 'Replacement proposal cannot remain uncommitted to the action chain';
  END IF;
  IF current_assignment."status" = 'active'
    AND current_assignment."action_code" <> current_assignment."snapshot_action"
    AND NOT EXISTS (
      SELECT 1 FROM "action_assignments" predecessor
      WHERE predecessor."replaced_by_id" = NEW."id"
        AND predecessor."status" = 'replaced'
    ) THEN
    RAISE EXCEPTION 'Replacement action requires a replaced predecessor';
  END IF;
  IF current_assignment."status" = 'replaced' AND NOT EXISTS (
    SELECT 1
    FROM "action_assignments" replacement
    WHERE replacement."id" = NEW."replaced_by_id"
      AND replacement."status" = 'active'
  ) THEN
    RAISE EXCEPTION 'Replaced action requires an active replacement';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "action_assignments_replacement_commit"
AFTER INSERT OR UPDATE ON "action_assignments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "healthos_validate_action_replacement_commit"();

CREATE FUNCTION "healthos_protect_feedback_event"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  target_user_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_user_id := OLD."user_id";
    IF target_user_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM "healthos_private"."privacy_delete_authorizations"
      WHERE "transaction_id" = txid_current() AND "user_id" = target_user_id
    ) THEN RETURN OLD; END IF;
    IF target_user_id IS NULL AND (
      SELECT count(*) FROM "healthos_private"."privacy_delete_authorizations"
      WHERE "transaction_id" = txid_current()
    ) = 1 THEN RETURN OLD; END IF;
  END IF;
  RAISE EXCEPTION 'Feedback events are append-only outside an exact privacy-delete transaction';
END;
$$;

CREATE TRIGGER "feedback_events_append_only"
BEFORE UPDATE OR DELETE ON "feedback_events"
FOR EACH ROW EXECUTE FUNCTION "healthos_protect_feedback_event"();

CREATE FUNCTION "healthos_validate_feedback_event_insert"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  action_user_id UUID;
BEGIN
  SELECT "user_id" INTO action_user_id
  FROM "action_assignments"
  WHERE "id" = NEW."action_assignment_id";
  IF action_user_id IS NULL OR action_user_id <> NEW."user_id" THEN
    RAISE EXCEPTION 'Feedback event ownership is invalid';
  END IF;
  IF NOT (
    (NEW."type" = 'complete' AND NEW."reason_code" IS NULL)
    OR (NEW."type" = 'skip' AND NEW."reason_code" IN ('no_time', 'tired', 'uncomfortable', 'weather', 'neutral'))
    OR (NEW."type" = 'lighter' AND NEW."reason_code" = 'too_hard')
    OR (NEW."type" = 'swap' AND (
      NEW."reason_code" IS NULL OR NEW."reason_code" IN (
        'too_hard', 'no_time', 'tired', 'uncomfortable', 'weather', 'neutral', 'no_safe_alternative'
      )
    ))
  ) THEN
    RAISE EXCEPTION 'Feedback event command and reason combination is unsupported';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "feedback_events_validate_insert"
BEFORE INSERT ON "feedback_events"
FOR EACH ROW EXECUTE FUNCTION "healthos_validate_feedback_event_insert"();

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
  DELETE FROM "recommendation_run_fact_inputs"
  WHERE "run_id" IN (SELECT "id" FROM "recommendation_runs" WHERE "user_id" = target_user_id);
  DELETE FROM "recommendation_run_lab_inputs"
  WHERE "run_id" IN (SELECT "id" FROM "recommendation_runs" WHERE "user_id" = target_user_id);
  DELETE FROM "security_events" WHERE "user_id" = target_user_id;
  DELETE FROM "users" WHERE "id" = target_user_id;
  DELETE FROM "healthos_private"."privacy_delete_authorizations"
  WHERE "transaction_id" = txid_current() AND "user_id" = target_user_id;
  RETURN TRUE;
END;
$$;
