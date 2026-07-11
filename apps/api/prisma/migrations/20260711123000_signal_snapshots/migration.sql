ALTER TABLE "signal_snapshots"
ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "freshness" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN "source_hash" TEXT,
ADD COLUMN "recommendation_snapshot_id" UUID;

UPDATE "signal_snapshots"
SET "source_hash" = encode(digest("provenance_json"::text, 'sha256'), 'hex');

WITH ranked AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "user_id", "signal_code"
    ORDER BY "local_date", "created_at", "id"
  )::integer AS "revision"
  FROM "signal_snapshots"
)
UPDATE "signal_snapshots" snapshot
SET "revision" = ranked."revision"
FROM ranked
WHERE ranked."id" = snapshot."id";

ALTER TABLE "signal_snapshots"
ALTER COLUMN "source_hash" SET NOT NULL,
ADD CONSTRAINT "signal_snapshots_revision_positive" CHECK ("revision" > 0),
ADD CONSTRAINT "signal_snapshots_source_hash_sha256" CHECK ("source_hash" ~ '^[a-f0-9]{64}$'),
ADD CONSTRAINT "signal_snapshots_recommendation_snapshot_id_fkey"
  FOREIGN KEY ("recommendation_snapshot_id") REFERENCES "recommendation_snapshots"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX "signal_snapshots_user_id_local_date_signal_code_key";

CREATE UNIQUE INDEX "signal_snapshots_user_id_signal_code_revision_key"
ON "signal_snapshots"("user_id", "signal_code", "revision");

CREATE UNIQUE INDEX "signal_snapshots_recommendation_snapshot_id_signal_code_key"
ON "signal_snapshots"("recommendation_snapshot_id", "signal_code");

CREATE INDEX "signal_snapshots_user_id_local_date_created_at_idx"
ON "signal_snapshots"("user_id", "local_date", "created_at");

CREATE FUNCTION "healthos_validate_signal_snapshot_insert"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  source_user UUID;
  source_date DATE;
  source_status "recommendation_review_status";
  source_run UUID;
  source_rule_input JSONB;
  source_snapshot_hash TEXT;
  source_profile UUID;
  source_profile_hash TEXT;
  source_bundle UUID;
  source_bundle_digest TEXT;
  source_bundle_status "rule_bundle_status";
  source_consent_epoch INTEGER;
  source_rule_key TEXT;
  source_fact_ids JSONB;
  source_fact_hashes JSONB;
  minimum_coverage NUMERIC;
  input_freshness TEXT;
  input_signal TEXT;
  expected_state TEXT;
  expected_trend TEXT;
  expected_freshness TEXT;
  expected_confidence NUMERIC;
  expected_drivers JSONB;
  expected_provenance JSONB;
  prior_state TEXT;
  expected_revision INTEGER;
BEGIN
  IF NEW."recommendation_snapshot_id" IS NULL THEN
    RAISE EXCEPTION 'Signal snapshot requires published recommendation provenance';
  END IF;
  SELECT run."user_id", run."local_date", snapshot."review_status", run."id",
    snapshot."canonical_rule_input_json", snapshot."snapshot_hash",
    run."input_snapshot_id", profile."snapshot_hash", run."rule_bundle_id",
    bundle."bundle_digest", bundle."status", run."consent_epoch",
    snapshot."provenance_json"->>'rule_key'
  INTO source_user, source_date, source_status, source_run, source_rule_input,
    source_snapshot_hash, source_profile, source_profile_hash, source_bundle,
    source_bundle_digest, source_bundle_status, source_consent_epoch, source_rule_key
  FROM "recommendation_snapshots" snapshot
  JOIN "recommendation_runs" run ON run."id" = snapshot."run_id"
  JOIN "profile_snapshots" profile ON profile."id" = run."input_snapshot_id"
  JOIN "rule_bundles" bundle ON bundle."id" = run."rule_bundle_id"
  WHERE snapshot."id" = NEW."recommendation_snapshot_id"
  FOR SHARE OF bundle;
  IF source_user IS NULL OR source_user <> NEW."user_id" OR source_date <> NEW."local_date"
    OR source_status <> 'published' THEN
    RAISE EXCEPTION 'Signal snapshot recommendation provenance is invalid';
  END IF;
  IF source_bundle_status <> 'active' THEN
    RAISE EXCEPTION 'Signal snapshot requires an active rule bundle';
  END IF;
  IF source_rule_key IS NULL OR source_rule_key = '' THEN
    RAISE EXCEPTION 'Signal snapshot requires exact rule provenance';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('signal-safety:rule:' || source_rule_key, 0));
  IF EXISTS (
    SELECT 1 FROM "safety_incidents" incident
    WHERE incident."source" = 'rule:' || source_rule_key
  ) THEN
    RAISE EXCEPTION 'Signal snapshot is blocked by a matching safety incident';
  END IF;
  IF NEW."signal_code" NOT IN ('sleep_recovery', 'fatty_liver', 'uric_acid', 'waist_weight')
    OR NEW."state" NOT IN ('stable', 'watch', 'unknown')
    OR NEW."trend" NOT IN ('improving', 'stable', 'worsening', 'unknown')
    OR NEW."freshness" NOT IN ('current', 'partial', 'stale', 'unknown') THEN
    RAISE EXCEPTION 'Signal snapshot semantic value is invalid';
  END IF;
  SELECT
    COALESCE(jsonb_agg(input."fact_revision_id"::text ORDER BY input."fact_revision_id"), '[]'::jsonb),
    COALESCE(jsonb_agg(input."input_hash" ORDER BY input."input_hash"), '[]'::jsonb),
    CASE
      WHEN count(input."fact_revision_id") = 0 OR bool_or(fact."coverage" IS NULL) THEN 0
      ELSE min(fact."coverage")
    END
  INTO source_fact_ids, source_fact_hashes, minimum_coverage
  FROM "recommendation_run_fact_inputs" input
  JOIN "daily_health_fact_revisions" fact ON fact."id" = input."fact_revision_id"
  WHERE input."run_id" = source_run;

  input_freshness := source_rule_input->>'freshness';
  input_signal := source_rule_input->'signals'->>NEW."signal_code";
  expected_state := CASE
    WHEN input_freshness IN ('missing', 'conflicting') THEN 'unknown'
    WHEN input_signal = 'normal' THEN 'stable'
    WHEN input_signal = 'elevated' THEN 'watch'
    ELSE 'unknown'
  END;
  expected_freshness := CASE
    WHEN input_freshness = 'stale' THEN 'stale'
    WHEN input_freshness = 'current' AND minimum_coverage < 1 THEN 'partial'
    WHEN input_freshness = 'current' THEN 'current'
    ELSE 'unknown'
  END;
  expected_confidence := CASE
    WHEN expected_state = 'unknown' OR expected_freshness = 'unknown' THEN 0
    ELSE minimum_coverage
  END;
  SELECT prior."state" INTO prior_state
  FROM "signal_snapshots" prior
  WHERE prior."user_id" = NEW."user_id"
    AND prior."signal_code" = NEW."signal_code"
    AND prior."local_date" < NEW."local_date"
    AND prior."recommendation_snapshot_id" IS NOT NULL
    AND prior."state" IN ('stable', 'watch', 'unknown')
  ORDER BY prior."local_date" DESC, prior."revision" DESC
  LIMIT 1;
  expected_trend := CASE
    WHEN expected_freshness NOT IN ('current', 'partial') OR prior_state IS NULL
      OR prior_state = 'unknown' OR expected_state = 'unknown' THEN 'unknown'
    WHEN prior_state = expected_state THEN 'stable'
    WHEN prior_state = 'watch' AND expected_state = 'stable' THEN 'improving'
    ELSE 'worsening'
  END;
  expected_drivers := jsonb_build_array(jsonb_build_object(
    'code', 'validated_rule_signal', 'source_fact_revision_ids', source_fact_ids
  ));
  expected_provenance := jsonb_build_object(
    'recommendation_snapshot_id', NEW."recommendation_snapshot_id",
    'recommendation_snapshot_hash', source_snapshot_hash,
    'profile_snapshot_id', source_profile,
    'profile_snapshot_hash', source_profile_hash,
    'rule_bundle_id', source_bundle,
    'rule_bundle_digest', source_bundle_digest,
    'consent_epoch', source_consent_epoch,
    'fact_revision_ids', source_fact_ids,
    'fact_input_hashes', source_fact_hashes
  );
  IF NEW."state" <> expected_state OR NEW."trend" <> expected_trend
    OR NEW."freshness" <> expected_freshness OR NEW."confidence" <> expected_confidence
    OR NEW."drivers_json" <> expected_drivers OR NEW."provenance_json" <> expected_provenance THEN
    RAISE EXCEPTION 'Signal snapshot does not match canonical published evidence';
  END IF;
  SELECT COALESCE(max(existing."revision"), 0) + 1
  INTO expected_revision
  FROM "signal_snapshots" existing
  WHERE existing."user_id" = NEW."user_id" AND existing."signal_code" = NEW."signal_code";
  IF NEW."revision" <> expected_revision THEN
    RAISE EXCEPTION 'Signal snapshot revision must advance exactly once';
  END IF;
  NEW."source_hash" := encode(digest(NEW."provenance_json"::text, 'sha256'), 'hex');
  RETURN NEW;
END;
$$;

CREATE TRIGGER "signal_snapshots_validate_insert"
BEFORE INSERT ON "signal_snapshots"
FOR EACH ROW EXECUTE FUNCTION "healthos_validate_signal_snapshot_insert"();

CREATE FUNCTION "healthos_protect_signal_snapshot"()
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
  RAISE EXCEPTION 'Signal snapshots are append-only outside an exact privacy-delete transaction';
END;
$$;

CREATE TRIGGER "signal_snapshots_append_only"
BEFORE UPDATE OR DELETE ON "signal_snapshots"
FOR EACH ROW EXECUTE FUNCTION "healthos_protect_signal_snapshot"();

CREATE FUNCTION "healthos_lock_signal_safety_incident"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW."source" IS NOT NULL AND NEW."source" <> '' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('signal-safety:' || NEW."source", 0));
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "safety_incidents_signal_projection_lock"
BEFORE INSERT OR UPDATE OF "source" ON "safety_incidents"
FOR EACH ROW EXECUTE FUNCTION "healthos_lock_signal_safety_incident"();
