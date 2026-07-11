ALTER TABLE "weekly_review_snapshots"
ADD COLUMN "cutoff_at" TIMESTAMPTZ(6),
ADD COLUMN "consent_epoch" INTEGER,
ADD COLUMN "friction_json" JSONB,
ADD COLUMN "source_hash" TEXT,
ADD COLUMN "snapshot_hash" TEXT;

ALTER TABLE "weekly_review_snapshots"
ADD CONSTRAINT "weekly_review_snapshots_revision_positive" CHECK ("revision" > 0),
ADD CONSTRAINT "weekly_review_snapshots_cutoff_after_week" CHECK (
  "cutoff_at" IS NULL OR "cutoff_at" >= ("week_start" + INTERVAL '7 days')
),
ADD CONSTRAINT "weekly_review_snapshots_consent_epoch_nonnegative" CHECK (
  "consent_epoch" IS NULL OR "consent_epoch" >= 0
),
ADD CONSTRAINT "weekly_review_snapshots_source_hash_sha256" CHECK (
  "source_hash" IS NULL OR "source_hash" ~ '^[a-f0-9]{64}$'
),
ADD CONSTRAINT "weekly_review_snapshots_snapshot_hash_sha256" CHECK (
  "snapshot_hash" IS NULL OR "snapshot_hash" ~ '^[a-f0-9]{64}$'
);

CREATE UNIQUE INDEX "weekly_review_snapshots_user_id_source_hash_key"
ON "weekly_review_snapshots"("user_id", "source_hash");

CREATE INDEX "weekly_review_snapshots_user_id_week_start_created_at_idx"
ON "weekly_review_snapshots"("user_id", "week_start", "created_at");

CREATE TABLE "weekly_review_shares" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "weekly_review_snapshot_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "variant" TEXT NOT NULL,
  "payload_json" JSONB NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "weekly_review_shares_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "weekly_review_shares_variant_allowed" CHECK ("variant" IN ('redacted', 'private')),
  CONSTRAINT "weekly_review_shares_payload_hash_sha256" CHECK ("payload_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "weekly_review_shares_expiry_after_creation" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "weekly_review_shares_weekly_review_snapshot_id_fkey" FOREIGN KEY ("weekly_review_snapshot_id")
    REFERENCES "weekly_review_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "weekly_review_shares_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "weekly_review_shares_weekly_review_snapshot_id_variant_key"
ON "weekly_review_shares"("weekly_review_snapshot_id", "variant");
CREATE INDEX "weekly_review_shares_user_id_expires_at_idx"
ON "weekly_review_shares"("user_id", "expires_at");

CREATE FUNCTION "healthos_validate_weekly_review_insert"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  latest_consent_epoch INTEGER;
  latest_consent_granted BOOLEAN;
  current_user_status "user_status";
  current_user_deleted_at TIMESTAMPTZ;
  privacy_status TEXT;
  expected_revision INTEGER;
  expected_source_hash TEXT;
  expected_snapshot_hash TEXT;
  expected_signal_ids JSONB;
  expected_action_ids JSONB;
  expected_feedback_ids JSONB;
  expected_coverage NUMERIC;
  expected_conclusion TEXT;
  expected_evidence JSONB;
  expected_friction JSONB;
  expected_next_actions JSONB;
  action_count INTEGER;
  completed_count INTEGER;
  skipped_count INTEGER;
  replaced_count INTEGER;
  source_key TEXT;
BEGIN
  IF NEW."cutoff_at" IS NULL OR NEW."consent_epoch" IS NULL OR NEW."friction_json" IS NULL
    OR NEW."source_hash" IS NULL OR NEW."snapshot_hash" IS NULL THEN
    RAISE EXCEPTION 'New weekly review snapshots require complete production provenance';
  END IF;
  SELECT "status", "deleted_at" INTO current_user_status, current_user_deleted_at
  FROM "users" WHERE "id" = NEW."user_id" FOR SHARE;
  SELECT "epoch", "granted" INTO latest_consent_epoch, latest_consent_granted
  FROM "consent_records"
  WHERE "user_id" = NEW."user_id" AND "consent_type" = 'health_processing'
  ORDER BY "epoch" DESC LIMIT 1;
  SELECT "status" INTO privacy_status FROM "privacy_reconciliation" WHERE "id" = 'global';
  IF current_user_status <> 'active' OR current_user_deleted_at IS NOT NULL
    OR latest_consent_granted IS DISTINCT FROM TRUE OR latest_consent_epoch <> NEW."consent_epoch"
    OR privacy_status <> 'ready' THEN
    RAISE EXCEPTION 'Weekly review authorization provenance is not current';
  END IF;
  IF NEW."conclusion" NOT IN (
    'review.conclusion.no_data', 'review.conclusion.partial_week', 'review.conclusion.improving',
    'review.conclusion.mixed', 'review.conclusion.watch', 'review.conclusion.stable'
  ) OR jsonb_typeof(NEW."evidence_json") <> 'array' OR jsonb_array_length(NEW."evidence_json") > 3
    OR jsonb_typeof(NEW."next_actions_json") <> 'array' OR jsonb_array_length(NEW."next_actions_json") > 3
    OR jsonb_typeof(NEW."friction_json") <> 'object' OR jsonb_typeof(NEW."provenance_json") <> 'object' THEN
    RAISE EXCEPTION 'Weekly review semantic contract is invalid';
  END IF;
  IF NEW."provenance_json"->>'consent_epoch' <> NEW."consent_epoch"::text
    OR (NEW."provenance_json"->>'cutoff_at')::timestamptz IS DISTINCT FROM NEW."cutoff_at"
    OR NEW."provenance_json"->>'week_start' <> NEW."week_start"::text THEN
    RAISE EXCEPTION 'Weekly review provenance identity is invalid';
  END IF;
  FOR source_key IN
    SELECT DISTINCT candidate."source" FROM (
      SELECT 'rule:' || (snapshot."provenance_json"->>'rule_key') AS "source"
      FROM "signal_snapshots" signal
      JOIN "recommendation_snapshots" snapshot ON snapshot."id" = signal."recommendation_snapshot_id"
      JOIN "recommendation_runs" run ON run."id" = snapshot."run_id"
      WHERE signal."user_id" = NEW."user_id"
        AND signal."local_date" >= NEW."week_start" AND signal."local_date" < NEW."week_start" + 7
        AND signal."created_at" <= NEW."cutoff_at" AND snapshot."review_status" = 'published'
        AND run."consent_epoch" = NEW."consent_epoch" AND snapshot."provenance_json"->>'rule_key' IS NOT NULL
      UNION
      SELECT 'rule:' || (snapshot."provenance_json"->>'rule_key') AS "source"
      FROM "action_assignments" action
      JOIN "recommendation_snapshots" snapshot ON snapshot."id" = action."recommendation_snapshot_id"
      JOIN "recommendation_runs" run ON run."id" = snapshot."run_id"
      WHERE action."user_id" = NEW."user_id"
        AND action."local_date" >= NEW."week_start" AND action."local_date" < NEW."week_start" + 7
        AND action."created_at" <= NEW."cutoff_at" AND snapshot."review_status" = 'published'
        AND run."consent_epoch" = NEW."consent_epoch" AND snapshot."provenance_json"->>'rule_key' IS NOT NULL
    ) candidate
    WHERE candidate."source" IS NOT NULL
    ORDER BY candidate."source"
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('signal-safety:' || source_key, 0));
  END LOOP;
  PERFORM 1 FROM "rule_bundles" bundle
  WHERE bundle."id" IN (
    SELECT run."rule_bundle_id"
    FROM "signal_snapshots" signal
    JOIN "recommendation_snapshots" snapshot ON snapshot."id" = signal."recommendation_snapshot_id"
    JOIN "recommendation_runs" run ON run."id" = snapshot."run_id"
    WHERE signal."user_id" = NEW."user_id"
      AND signal."local_date" >= NEW."week_start" AND signal."local_date" < NEW."week_start" + 7
      AND signal."created_at" <= NEW."cutoff_at"
    UNION
    SELECT run."rule_bundle_id"
    FROM "action_assignments" action
    JOIN "recommendation_snapshots" snapshot ON snapshot."id" = action."recommendation_snapshot_id"
    JOIN "recommendation_runs" run ON run."id" = snapshot."run_id"
    WHERE action."user_id" = NEW."user_id"
      AND action."local_date" >= NEW."week_start" AND action."local_date" < NEW."week_start" + 7
      AND action."created_at" <= NEW."cutoff_at"
  ) ORDER BY bundle."id" FOR SHARE;
  WITH eligible AS (
    SELECT DISTINCT ON (signal."local_date", signal."signal_code")
      signal."id", signal."local_date"
    FROM "signal_snapshots" signal
    JOIN "recommendation_snapshots" snapshot ON snapshot."id" = signal."recommendation_snapshot_id"
    JOIN "recommendation_runs" run ON run."id" = snapshot."run_id"
    JOIN "rule_bundles" bundle ON bundle."id" = run."rule_bundle_id"
    WHERE signal."user_id" = NEW."user_id"
      AND signal."local_date" >= NEW."week_start"
      AND signal."local_date" < NEW."week_start" + 7
      AND signal."created_at" <= NEW."cutoff_at"
      AND snapshot."review_status" = 'published'
      AND run."consent_epoch" = NEW."consent_epoch"
      AND bundle."status" IN ('active', 'superseded')
      AND snapshot."provenance_json"->>'rule_key' IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "safety_incidents" incident
        WHERE incident."source" = 'rule:' || (snapshot."provenance_json"->>'rule_key')
      )
    ORDER BY signal."local_date", signal."signal_code", signal."revision" DESC, signal."id" DESC
  )
  SELECT
    COALESCE(jsonb_agg("id"::text ORDER BY "id"), '[]'::jsonb),
    round((count(DISTINCT "local_date")::numeric / 7), 5)
  INTO expected_signal_ids, expected_coverage
  FROM eligible;

  WITH eligible AS (
    SELECT action."id"
    FROM "action_assignments" action
    JOIN "recommendation_snapshots" snapshot ON snapshot."id" = action."recommendation_snapshot_id"
    JOIN "recommendation_runs" run ON run."id" = snapshot."run_id"
    JOIN "rule_bundles" bundle ON bundle."id" = run."rule_bundle_id"
    WHERE action."user_id" = NEW."user_id"
      AND action."local_date" >= NEW."week_start"
      AND action."local_date" < NEW."week_start" + 7
      AND action."created_at" <= NEW."cutoff_at"
      AND action."action_code" IN (
        'SLEEP_WIND_DOWN', 'SLEEP_WIND_DOWN_LIGHT', 'POST_MEAL_WALK', 'SUGARY_DRINK_SWAP'
      )
      AND snapshot."review_status" = 'published'
      AND run."consent_epoch" = NEW."consent_epoch"
      AND bundle."status" IN ('active', 'superseded')
      AND snapshot."provenance_json"->>'rule_key' IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "safety_incidents" incident
        WHERE incident."source" = 'rule:' || (snapshot."provenance_json"->>'rule_key')
      )
  )
  SELECT COALESCE(jsonb_agg("id"::text ORDER BY "id"), '[]'::jsonb)
  INTO expected_action_ids FROM eligible;

  SELECT COALESCE(jsonb_agg(feedback."id"::text ORDER BY feedback."id"), '[]'::jsonb)
  INTO expected_feedback_ids
  FROM "feedback_events" feedback
  WHERE feedback."action_assignment_id" IN (
    SELECT value::uuid FROM jsonb_array_elements_text(expected_action_ids)
  ) AND feedback."occurred_at" <= NEW."cutoff_at"
    AND feedback."result_json"->>'outcome' IN ('completed', 'skipped', 'replaced', 'no_safe_alternative');

  IF NEW."provenance_json"->'signal_snapshot_ids' IS DISTINCT FROM expected_signal_ids
    OR NEW."provenance_json"->'action_assignment_ids' IS DISTINCT FROM expected_action_ids
    OR NEW."provenance_json"->'feedback_event_ids' IS DISTINCT FROM expected_feedback_ids
    OR NEW."coverage" <> expected_coverage THEN
    RAISE EXCEPTION 'Weekly review source provenance is incomplete or ineligible';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW."next_actions_json") action
    WHERE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(expected_action_ids) source(value)
      WHERE source.value = action->>'assignment_id'
    )
  ) THEN
    RAISE EXCEPTION 'Weekly review next action is not a validated source assignment';
  END IF;
  WITH eligible AS (
    SELECT DISTINCT ON (signal."local_date", signal."signal_code")
      signal."id", signal."local_date", signal."signal_code", signal."state", signal."trend", signal."freshness"
    FROM "signal_snapshots" signal
    JOIN "recommendation_snapshots" snapshot ON snapshot."id" = signal."recommendation_snapshot_id"
    JOIN "recommendation_runs" run ON run."id" = snapshot."run_id"
    JOIN "rule_bundles" bundle ON bundle."id" = run."rule_bundle_id"
    WHERE signal."id" IN (SELECT value::uuid FROM jsonb_array_elements_text(expected_signal_ids))
    ORDER BY signal."local_date", signal."signal_code", signal."revision" DESC, signal."id" DESC
  ), signal_days AS (
    SELECT "signal_code", count(DISTINCT "local_date")::integer AS "days_observed"
    FROM eligible GROUP BY "signal_code"
  ), latest AS (
    SELECT DISTINCT ON (eligible."signal_code")
      eligible."signal_code", eligible."state", eligible."trend", eligible."freshness", signal_days."days_observed"
    FROM eligible JOIN signal_days USING ("signal_code")
    ORDER BY eligible."signal_code", eligible."local_date" DESC, eligible."id" DESC
  ), limited AS (
    SELECT * FROM latest ORDER BY "signal_code" LIMIT 3
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'signal_code', "signal_code", 'state', "state", 'trend', "trend",
    'freshness', "freshness", 'days_observed', "days_observed"
  ) ORDER BY "signal_code"), '[]'::jsonb)
  INTO expected_evidence FROM limited;

  WITH eligible AS (
    SELECT signal."state", signal."trend"
    FROM "signal_snapshots" signal
    WHERE signal."id" IN (SELECT value::uuid FROM jsonb_array_elements_text(expected_signal_ids))
  )
  SELECT CASE
    WHEN count(*) = 0 THEN 'review.conclusion.no_data'
    WHEN expected_coverage < 1 THEN 'review.conclusion.partial_week'
    WHEN bool_or("trend" = 'improving') AND bool_or("trend" = 'worsening') THEN 'review.conclusion.mixed'
    WHEN bool_or("trend" = 'improving') THEN 'review.conclusion.improving'
    WHEN bool_or("state" = 'watch') THEN 'review.conclusion.watch'
    ELSE 'review.conclusion.stable'
  END INTO expected_conclusion FROM eligible;

  action_count := jsonb_array_length(expected_action_ids);
  SELECT
    count(*) FILTER (WHERE feedback."result_json"->>'outcome' = 'completed')::integer,
    count(*) FILTER (WHERE feedback."result_json"->>'outcome' IN ('skipped', 'no_safe_alternative'))::integer,
    count(*) FILTER (WHERE feedback."result_json"->>'outcome' = 'replaced')::integer
  INTO completed_count, skipped_count, replaced_count
  FROM "feedback_events" feedback
  WHERE feedback."id" IN (SELECT value::uuid FROM jsonb_array_elements_text(expected_feedback_ids));
  expected_friction := jsonb_build_object(
    'code', CASE
      WHEN action_count = 0 THEN 'review.friction.no_actions'
      WHEN skipped_count = action_count THEN 'review.friction.all_skipped'
      WHEN completed_count > skipped_count + replaced_count THEN 'review.friction.mostly_completed'
      ELSE 'review.friction.mixed'
    END,
    'completed', completed_count, 'skipped', skipped_count, 'replaced', replaced_count
  );

  WITH eligible AS (
    SELECT action."id", action."action_code", action."local_date", action."created_at"
    FROM "action_assignments" action
    WHERE action."id" IN (SELECT value::uuid FROM jsonb_array_elements_text(expected_action_ids))
  ), unique_actions AS (
    SELECT DISTINCT ON ("action_code") * FROM eligible
    ORDER BY "action_code", "local_date" DESC, "created_at", "id"
  ), limited AS (
    SELECT * FROM unique_actions
    ORDER BY "local_date" DESC, "action_code", "created_at", "id" LIMIT 3
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'assignment_id', "id", 'action_code', "action_code"
  ) ORDER BY "local_date" DESC, "action_code", "created_at", "id"), '[]'::jsonb)
  INTO expected_next_actions FROM limited;

  IF NEW."conclusion" <> expected_conclusion
    OR NEW."evidence_json" IS DISTINCT FROM expected_evidence
    OR NEW."friction_json" IS DISTINCT FROM expected_friction
    OR NEW."next_actions_json" IS DISTINCT FROM expected_next_actions THEN
    RAISE EXCEPTION 'Weekly review does not match deterministic source semantics';
  END IF;
  expected_source_hash := encode(digest(NEW."provenance_json"::text, 'sha256'), 'hex');
  expected_snapshot_hash := encode(digest(jsonb_build_object(
    'week_start', NEW."week_start", 'cutoff_at', NEW."cutoff_at", 'consent_epoch', NEW."consent_epoch",
    'coverage', NEW."coverage", 'conclusion', NEW."conclusion", 'evidence', NEW."evidence_json",
    'friction', NEW."friction_json", 'next_actions', NEW."next_actions_json", 'provenance', NEW."provenance_json"
  )::text, 'sha256'), 'hex');
  NEW."source_hash" := expected_source_hash;
  NEW."snapshot_hash" := expected_snapshot_hash;
  SELECT COALESCE(max("revision"), 0) + 1 INTO expected_revision
  FROM "weekly_review_snapshots"
  WHERE "user_id" = NEW."user_id" AND "week_start" = NEW."week_start";
  IF NEW."revision" <> expected_revision THEN
    RAISE EXCEPTION 'Weekly review revision must advance exactly once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "weekly_review_snapshots_validate_insert"
BEFORE INSERT ON "weekly_review_snapshots"
FOR EACH ROW EXECUTE FUNCTION "healthos_validate_weekly_review_insert"();

DROP TRIGGER "weekly_review_snapshots_append_only" ON "weekly_review_snapshots";

CREATE FUNCTION "healthos_protect_weekly_review"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (
    SELECT 1 FROM "healthos_private"."privacy_delete_authorizations"
    WHERE "transaction_id" = txid_current() AND "user_id" = OLD."user_id"
  ) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Weekly review records are append-only outside an exact privacy-delete transaction';
END;
$$;

CREATE TRIGGER "weekly_review_snapshots_append_only"
BEFORE UPDATE OR DELETE ON "weekly_review_snapshots"
FOR EACH ROW EXECUTE FUNCTION "healthos_protect_weekly_review"();

CREATE FUNCTION "healthos_validate_weekly_review_share_insert"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  review_user UUID;
  review_week_start DATE;
  review_coverage NUMERIC;
  review_conclusion TEXT;
  review_evidence JSONB;
  review_friction JSONB;
  review_next_actions JSONB;
  redacted_next_actions JSONB;
  expected_payload JSONB;
  expected_payload_hash TEXT;
BEGIN
  SELECT "user_id", "week_start", "coverage", "conclusion", "evidence_json", "friction_json", "next_actions_json"
  INTO review_user, review_week_start, review_coverage, review_conclusion,
    review_evidence, review_friction, review_next_actions
  FROM "weekly_review_snapshots"
  WHERE "id" = NEW."weekly_review_snapshot_id";
  SELECT COALESCE(jsonb_agg(jsonb_build_object('action_code', action->>'action_code') ORDER BY ordinal), '[]'::jsonb)
  INTO redacted_next_actions
  FROM jsonb_array_elements(review_next_actions) WITH ORDINALITY AS source(action, ordinal);
  expected_payload_hash := encode(digest(NEW."payload_json"::text, 'sha256'), 'hex');
  expected_payload := jsonb_build_object(
    'schema_version', 1,
    'review_id', NEW."weekly_review_snapshot_id",
    'variant', NEW."variant",
    'week_start', review_week_start,
    'week_end', review_week_start + 6,
    'coverage', review_coverage,
    'conclusion_key', review_conclusion,
    'evidence', review_evidence,
    'friction', review_friction,
    'next_actions', CASE WHEN NEW."variant" = 'private' THEN review_next_actions ELSE redacted_next_actions END
  );
  IF review_user IS NULL OR review_user <> NEW."user_id"
    OR NEW."payload_json" IS DISTINCT FROM expected_payload THEN
    RAISE EXCEPTION 'Weekly review share does not match its immutable review';
  END IF;
  NEW."payload_hash" := expected_payload_hash;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "weekly_review_shares_validate_insert"
BEFORE INSERT ON "weekly_review_shares"
FOR EACH ROW EXECUTE FUNCTION "healthos_validate_weekly_review_share_insert"();

CREATE TRIGGER "weekly_review_shares_append_only"
BEFORE UPDATE OR DELETE ON "weekly_review_shares"
FOR EACH ROW EXECUTE FUNCTION "healthos_protect_weekly_review"();
