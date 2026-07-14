-- Expand the existing audited feature-control path without creating a default
-- revision. Missing feature.llm_generation therefore remains fail-closed.
ALTER TABLE "safety_control_revisions"
DROP CONSTRAINT "safety_control_revisions_key_allowed";

ALTER TABLE "safety_control_revisions"
ADD CONSTRAINT "safety_control_revisions_key_allowed" CHECK (
  ("control_type" = 'kill_switch' AND "control_key" IN (
    'global.proactive_messages', 'channel.delivery', 'llm.generation',
    'rule.bundle', 'user.recommendations', 'review.share'
  ))
  OR
  ("control_type" = 'feature_flag' AND "control_key" IN (
    'feature.daily_recommendations', 'feature.weekly_review_share',
    'feature.channel_delivery', 'feature.llm_generation'
  ))
);

ALTER TABLE "safety_control_revisions"
DROP CONSTRAINT "safety_control_revisions_key_scope_match";

ALTER TABLE "safety_control_revisions"
ADD CONSTRAINT "safety_control_revisions_key_scope_match" CHECK (
  ("control_key" IN (
    'global.proactive_messages', 'llm.generation', 'review.share',
    'feature.daily_recommendations', 'feature.weekly_review_share',
    'feature.llm_generation'
  ) AND "scope_type" = 'global')
  OR ("control_key" IN ('channel.delivery', 'feature.channel_delivery') AND "scope_type" = 'channel')
  OR ("control_key" = 'rule.bundle' AND "scope_type" = 'rule_bundle')
  OR ("control_key" = 'user.recommendations' AND "scope_type" = 'user')
);

-- Coach holds this transaction-scoped lock from evidence validation through
-- turn persistence. The existing safety_incidents append-only trigger takes
-- the same source lock before every rule incident insert, so either the
-- incident commits first and Coach observes it, or Coach persists first and
-- the incident waits. No mutable incident acknowledgement is introduced.
CREATE FUNCTION "healthos_lock_coach_rule_evidence"(source_rule_key TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
STRICT
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  source_key TEXT := 'rule:' || source_rule_key;
BEGIN
  IF source_rule_key = '' THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(source_key, 0));
  RETURN NOT EXISTS (
    SELECT 1 FROM "safety_incidents" WHERE "source" = source_key
  );
END;
$$;

ALTER TABLE "coach_threads"
  ADD COLUMN "client_thread_id" UUID,
  ADD COLUMN "idempotency_key" UUID,
  ADD COLUMN "request_hash" TEXT;

UPDATE "coach_threads"
SET
  "client_thread_id" = "id",
  "idempotency_key" = "id",
  "request_hash" = encode(digest("id"::text, 'sha256'), 'hex');

ALTER TABLE "coach_threads"
  ALTER COLUMN "client_thread_id" SET NOT NULL,
  ALTER COLUMN "idempotency_key" SET NOT NULL,
  ALTER COLUMN "request_hash" SET NOT NULL,
  ADD CONSTRAINT "coach_threads_request_hash_sha256" CHECK ("request_hash" ~ '^[a-f0-9]{64}$');

CREATE UNIQUE INDEX "coach_threads_user_id_client_thread_id_key"
ON "coach_threads"("user_id", "client_thread_id");
CREATE UNIQUE INDEX "coach_threads_user_id_idempotency_key_key"
ON "coach_threads"("user_id", "idempotency_key");
CREATE UNIQUE INDEX "coach_threads_id_user_id_key"
ON "coach_threads"("id", "user_id");
CREATE UNIQUE INDEX "profile_candidates_id_user_id_key"
ON "profile_candidates"("id", "user_id");

CREATE TABLE "coach_turns" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "thread_id" UUID NOT NULL,
  "idempotency_key" UUID NOT NULL,
  "request_hash" TEXT NOT NULL,
  "intent" TEXT NOT NULL,
  "result_json" JSONB NOT NULL,
  "gate_evidence_json" JSONB NOT NULL,
  "candidate_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "coach_turns_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "coach_turns_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "coach_turns_thread_id_user_id_fkey" FOREIGN KEY ("thread_id", "user_id") REFERENCES "coach_threads"("id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "coach_turns_candidate_id_user_id_fkey" FOREIGN KEY ("candidate_id", "user_id") REFERENCES "profile_candidates"("id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "coach_turns_request_hash_sha256" CHECK ("request_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "coach_turns_result_object" CHECK (jsonb_typeof("result_json") = 'object'),
  CONSTRAINT "coach_turns_gate_object" CHECK (jsonb_typeof("gate_evidence_json") = 'object')
);

CREATE UNIQUE INDEX "coach_turns_user_id_idempotency_key_key"
ON "coach_turns"("user_id", "idempotency_key");
CREATE UNIQUE INDEX "coach_turns_id_thread_id_user_id_key"
ON "coach_turns"("id", "thread_id", "user_id");
CREATE INDEX "coach_turns_thread_id_created_at_idx"
ON "coach_turns"("thread_id", "created_at");

ALTER TABLE "coach_messages"
  ADD COLUMN "user_id" UUID,
  ADD COLUMN "turn_id" UUID,
  ADD COLUMN "sequence" INTEGER,
  ADD COLUMN "content_hash" TEXT,
  ADD COLUMN "evidence_hash" TEXT,
  ADD COLUMN "action_code" TEXT,
  ADD COLUMN "fixed_response_code" TEXT,
  ADD COLUMN "needs_human_review" BOOLEAN NOT NULL DEFAULT false;

WITH ranked AS (
  SELECT "id", row_number() OVER (PARTITION BY "thread_id" ORDER BY "created_at", "id") AS ordinal
  FROM "coach_messages"
)
UPDATE "coach_messages" message
SET
  "user_id" = thread."user_id",
  "sequence" = ranked.ordinal,
  "content_hash" = encode(digest(message."content", 'sha256'), 'hex'),
  "evidence_hash" = encode(digest(message."sources_json"::text, 'sha256'), 'hex')
FROM ranked, "coach_threads" thread
WHERE message."id" = ranked."id" AND thread."id" = message."thread_id";

ALTER TABLE "coach_messages"
  DROP CONSTRAINT "coach_messages_thread_id_fkey",
  ALTER COLUMN "user_id" SET NOT NULL,
  ALTER COLUMN "sequence" SET NOT NULL,
  ALTER COLUMN "content_hash" SET NOT NULL,
  ALTER COLUMN "evidence_hash" SET NOT NULL,
  ADD CONSTRAINT "coach_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "coach_messages_thread_id_user_id_fkey" FOREIGN KEY ("thread_id", "user_id") REFERENCES "coach_threads"("id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "coach_messages_turn_id_thread_id_user_id_fkey" FOREIGN KEY ("turn_id", "thread_id", "user_id") REFERENCES "coach_turns"("id", "thread_id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "coach_messages_sequence_positive" CHECK ("sequence" > 0),
  ADD CONSTRAINT "coach_messages_role_allowed" CHECK ("role" IN ('user', 'assistant')),
  ADD CONSTRAINT "coach_messages_content_hash_sha256" CHECK ("content_hash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "coach_messages_evidence_hash_sha256" CHECK ("evidence_hash" ~ '^[a-f0-9]{64}$');

CREATE UNIQUE INDEX "coach_messages_thread_id_sequence_key"
ON "coach_messages"("thread_id", "sequence");

CREATE FUNCTION "healthos_validate_coach_turn_insert"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  thread_owner UUID;
  thread_summary_version INTEGER;
  current_consent_epoch INTEGER;
  current_consent_granted BOOLEAN;
  candidate_owner UUID;
  candidate_status "profile_candidate_status";
BEGIN
  SELECT "user_id", "summary_version"
  INTO thread_owner, thread_summary_version
  FROM "coach_threads"
  WHERE "id" = NEW."thread_id";
  IF thread_owner IS DISTINCT FROM NEW."user_id" THEN
    RAISE EXCEPTION 'Coach turn thread ownership mismatch' USING ERRCODE = '23514';
  END IF;
  IF NULLIF(NEW."gate_evidence_json"->>'summaryVersion', '')::integer
      IS DISTINCT FROM thread_summary_version THEN
    RAISE EXCEPTION 'Coach turn summary version mismatch' USING ERRCODE = '23514';
  END IF;
  SELECT "epoch", "granted" INTO current_consent_epoch, current_consent_granted
  FROM "consent_records"
  WHERE "user_id" = NEW."user_id" AND "consent_type" = 'health_processing'
  ORDER BY "epoch" DESC LIMIT 1;
  IF NULLIF(NEW."gate_evidence_json"->>'consentEpoch', '')::integer
      IS DISTINCT FROM current_consent_epoch OR current_consent_granted IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Coach turn consent epoch mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW."result_json"->>'intent' IS DISTINCT FROM NEW."intent" THEN
    RAISE EXCEPTION 'Coach turn result intent mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW."candidate_id" IS NOT NULL THEN
    SELECT "user_id", "status" INTO candidate_owner, candidate_status
    FROM "profile_candidates" WHERE "id" = NEW."candidate_id";
    IF candidate_owner IS DISTINCT FROM NEW."user_id" OR candidate_status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'Coach turn candidate must be owned and pending' USING ERRCODE = '23514';
    END IF;
    IF NEW."result_json"#>>'{candidate,id}' IS DISTINCT FROM NEW."candidate_id"::text
      OR NEW."result_json"#>>'{candidate,status}' IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'Coach turn candidate result mismatch' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."result_json"->'candidate' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'Coach turn candidate identity mismatch' USING ERRCODE = '23514';
  END IF;
  IF coalesce((NEW."result_json"->>'fixed_response')::boolean, false) = false AND (
    coalesce((NEW."gate_evidence_json"->>'featureEnabled')::boolean, false) = false
    OR coalesce((NEW."gate_evidence_json"->>'killSwitchActive')::boolean, true) = true
    OR NEW."gate_evidence_json"->>'controlEpoch' IN ('missing', 'not_required')
  ) THEN
    RAISE EXCEPTION 'Generated Coach turn lacks an enabled authorization gate' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "coach_turns_validate_insert"
BEFORE INSERT ON "coach_turns"
FOR EACH ROW EXECUTE FUNCTION "healthos_validate_coach_turn_insert"();

CREATE FUNCTION "healthos_validate_coach_message_insert"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW."content_hash" IS DISTINCT FROM encode(digest(NEW."content", 'sha256'), 'hex') THEN
    RAISE EXCEPTION 'Coach message content hash mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW."evidence_hash" IS DISTINCT FROM encode(digest(NEW."sources_json"::text, 'sha256'), 'hex') THEN
    RAISE EXCEPTION 'Coach message evidence hash mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW."turn_id" IS NOT NULL AND NEW."role" = 'user' AND (
    NEW."sources_json" IS DISTINCT FROM '[]'::jsonb
    OR NEW."action_code" IS NOT NULL
    OR NEW."fixed_response_code" IS NOT NULL
    OR NEW."needs_human_review"
    OR NEW."model_metadata" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Coach user message contains assistant-only fields' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "coach_messages_validate_insert"
BEFORE INSERT ON "coach_messages"
FOR EACH ROW EXECUTE FUNCTION "healthos_validate_coach_message_insert"();

CREATE FUNCTION "healthos_validate_coach_turn_pair"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  target_turn_id UUID;
  turn_row "coach_turns"%ROWTYPE;
  user_message "coach_messages"%ROWTYPE;
  assistant_message "coach_messages"%ROWTYPE;
  message_count INTEGER;
  user_count INTEGER;
  assistant_count INTEGER;
BEGIN
  target_turn_id := CASE
    WHEN TG_TABLE_NAME = 'coach_turns' THEN NULLIF(to_jsonb(NEW)->>'id', '')::UUID
    ELSE NULLIF(to_jsonb(NEW)->>'turn_id', '')::UUID
  END;
  IF target_turn_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO turn_row FROM "coach_turns" WHERE "id" = target_turn_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT
    count(*),
    count(*) FILTER (WHERE "role" = 'user'),
    count(*) FILTER (WHERE "role" = 'assistant')
  INTO message_count, user_count, assistant_count
  FROM "coach_messages" WHERE "turn_id" = target_turn_id;
  IF message_count <> 2 OR user_count <> 1 OR assistant_count <> 1 THEN
    RAISE EXCEPTION 'Coach turn requires exactly one user and one assistant message' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO user_message FROM "coach_messages"
  WHERE "turn_id" = target_turn_id AND "role" = 'user';
  SELECT * INTO assistant_message FROM "coach_messages"
  WHERE "turn_id" = target_turn_id AND "role" = 'assistant';
  IF assistant_message."sequence" <> user_message."sequence" + 1 THEN
    RAISE EXCEPTION 'Coach turn message sequence is not canonical' USING ERRCODE = '23514';
  END IF;
  IF user_message."intent" IS DISTINCT FROM turn_row."intent"
    OR user_message."safety_class" IS DISTINCT FROM turn_row."result_json"->>'safety_class'
    OR assistant_message."intent" IS DISTINCT FROM turn_row."intent"
    OR assistant_message."content" IS DISTINCT FROM turn_row."result_json"->>'short_answer'
    OR assistant_message."safety_class" IS DISTINCT FROM turn_row."result_json"->>'safety_class'
    OR assistant_message."action_code" IS DISTINCT FROM turn_row."result_json"->>'action_code'
    OR assistant_message."fixed_response_code" IS DISTINCT FROM turn_row."result_json"->>'fixed_response_code'
    OR assistant_message."needs_human_review" IS DISTINCT FROM (turn_row."result_json"->>'needs_human_review')::boolean
    OR assistant_message."sources_json" IS DISTINCT FROM turn_row."result_json"->'source_ids' THEN
    RAISE EXCEPTION 'Coach turn message pair does not match immutable result' USING ERRCODE = '23514';
  END IF;
  IF (turn_row."result_json"->>'fixed_response')::boolean = true
    AND assistant_message."model_metadata" IS NOT NULL THEN
    RAISE EXCEPTION 'Fixed Coach response cannot contain model metadata' USING ERRCODE = '23514';
  END IF;
  IF (turn_row."result_json"->>'fixed_response')::boolean = false
    AND jsonb_typeof(assistant_message."model_metadata") IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Generated Coach response requires model metadata' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "coach_turns_pair_complete"
AFTER INSERT ON "coach_turns"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "healthos_validate_coach_turn_pair"();

CREATE CONSTRAINT TRIGGER "coach_messages_pair_complete"
AFTER INSERT ON "coach_messages"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "healthos_validate_coach_turn_pair"();

CREATE FUNCTION "healthos_coach_privacy_delete_authorized"(target_user_id UUID)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM "healthos_private"."privacy_delete_authorizations"
    WHERE "transaction_id" = txid_current() AND "user_id" = target_user_id
  );
$$;

CREATE FUNCTION "healthos_protect_coach_thread"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND healthos_coach_privacy_delete_authorized(OLD."user_id") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Coach thread identity and summary are immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "coach_threads_immutable"
BEFORE UPDATE OR DELETE ON "coach_threads"
FOR EACH ROW EXECUTE FUNCTION "healthos_protect_coach_thread"();

CREATE FUNCTION "healthos_protect_coach_turn"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND healthos_coach_privacy_delete_authorized(OLD."user_id") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Coach turn is append-only and immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "coach_turns_immutable"
BEFORE UPDATE OR DELETE ON "coach_turns"
FOR EACH ROW EXECUTE FUNCTION "healthos_protect_coach_turn"();

CREATE FUNCTION "healthos_protect_coach_message"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND healthos_coach_privacy_delete_authorized(OLD."user_id") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Coach message is append-only and immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "coach_messages_immutable"
BEFORE UPDATE OR DELETE ON "coach_messages"
FOR EACH ROW EXECUTE FUNCTION "healthos_protect_coach_message"();
