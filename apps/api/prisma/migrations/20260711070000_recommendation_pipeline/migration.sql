CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE "consent_records" VALIDATE CONSTRAINT "consent_records_known_purpose";
ALTER TABLE "consent_records" VALIDATE CONSTRAINT "consent_records_known_source";
ALTER TABLE "daily_health_fact_revisions" VALIDATE CONSTRAINT "daily_health_fact_revisions_metric_known";

-- Replace the legacy owner/GUC escape hatch. Append-only deletion is permitted
-- only for rows that carry the exact user authorized by the privacy transaction.
CREATE OR REPLACE FUNCTION "healthos_prevent_append_only_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  row_user_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_user_id := NULLIF(to_jsonb(OLD)->>'user_id', '')::UUID;
    IF row_user_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM "healthos_private"."privacy_delete_authorizations"
      WHERE "transaction_id" = txid_current() AND "user_id" = row_user_id
    ) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION '% is append-only; create a new revision or event', TG_TABLE_NAME;
END;
$$;

CREATE TYPE "rule_bundle_status" AS ENUM (
  'draft_unapproved',
  'approval_pending',
  'approved_not_published',
  'active',
  'superseded',
  'rolled_back'
);

CREATE TYPE "recommendation_review_event_type" AS ENUM (
  'submitted',
  'approved',
  'edited',
  'rejected',
  'auto_published',
  'missed_sla',
  'blocked'
);

ALTER TABLE "rule_bundles"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "rule_bundle_status"
    USING CASE
      WHEN "status" = 'published' THEN 'draft_unapproved'::"rule_bundle_status"
      WHEN "status" = 'approval_pending' THEN 'approval_pending'::"rule_bundle_status"
      WHEN "status" = 'approved_not_published' THEN 'approved_not_published'::"rule_bundle_status"
      WHEN "status" = 'rolled_back' THEN 'rolled_back'::"rule_bundle_status"
      ELSE 'draft_unapproved'::"rule_bundle_status"
    END,
  ALTER COLUMN "status" SET DEFAULT 'draft_unapproved',
  ADD COLUMN "content_json" JSONB,
  ADD COLUMN "bundle_digest" TEXT,
  ADD COLUMN "auto_publish_eligible" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "rolled_back_at" TIMESTAMPTZ(6),
  ADD COLUMN "last_rollback_event_id" UUID,
  ADD COLUMN "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "rule_bundles"
  ADD CONSTRAINT "rule_bundles_digest_sha256" CHECK (
    "bundle_digest" IS NULL OR "bundle_digest" ~ '^[a-f0-9]{64}$'
  );

CREATE UNIQUE INDEX "rule_bundles_one_active_idx"
ON "rule_bundles" ((true)) WHERE "status" = 'active';

CREATE FUNCTION "healthos_derive_rule_bundle_identity"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."content_json" IS NULL OR length(trim(NEW."version")) = 0 THEN
    RAISE EXCEPTION 'New rule bundle requires versioned content';
  END IF;
  NEW."content_hash" := encode(digest(NEW."content_json"::text, 'sha256'), 'hex');
  NEW."bundle_digest" := encode(digest(NEW."version" || ':' || NEW."content_hash", 'sha256'), 'hex');
  NEW."status" := 'draft_unapproved';
  NEW."auto_publish_eligible" := false;
  NEW."published_by" := NULL;
  NEW."published_at" := NULL;
  NEW."rolled_back_at" := NULL;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "rule_bundles_derive_identity"
BEFORE INSERT ON "rule_bundles"
FOR EACH ROW EXECUTE FUNCTION "healthos_derive_rule_bundle_identity"();

CREATE TABLE "rule_bundle_approvals" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "rule_bundle_id" UUID NOT NULL,
  "role" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "normalized_actor" TEXT NOT NULL,
  "bundle_digest" TEXT NOT NULL,
  "approved_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "rule_bundle_approvals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "rule_bundle_approvals_role" CHECK ("role" IN ('technical', 'medical')),
  CONSTRAINT "rule_bundle_approvals_actor" CHECK (
    length(trim("actor_id")) > 0 AND
    "normalized_actor" = lower(trim("actor_id"))
  ),
  CONSTRAINT "rule_bundle_approvals_digest_sha256" CHECK ("bundle_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "rule_bundle_approvals_rule_bundle_id_fkey"
    FOREIGN KEY ("rule_bundle_id") REFERENCES "rule_bundles"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "rule_bundle_approvals_rule_bundle_id_role_key"
ON "rule_bundle_approvals"("rule_bundle_id", "role");
CREATE UNIQUE INDEX "rule_bundle_approvals_rule_bundle_id_normalized_actor_key"
ON "rule_bundle_approvals"("rule_bundle_id", "normalized_actor");
CREATE INDEX "rule_bundle_approvals_rule_bundle_id_approved_at_idx"
ON "rule_bundle_approvals"("rule_bundle_id", "approved_at");

CREATE FUNCTION "healthos_validate_rule_bundle_approval"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_bundle "rule_bundles"%ROWTYPE;
BEGIN
  NEW."normalized_actor" := lower(trim(NEW."actor_id"));
  SELECT * INTO current_bundle
  FROM "rule_bundles"
  WHERE "id" = NEW."rule_bundle_id"
  FOR UPDATE;

  IF current_bundle."status" NOT IN ('draft_unapproved', 'approval_pending')
    OR current_bundle."content_json" IS NULL
    OR current_bundle."bundle_digest" IS NULL
    OR current_bundle."content_hash" !~ '^[a-f0-9]{64}$'
    OR current_bundle."bundle_digest" <> encode(digest(current_bundle."version" || ':' || current_bundle."content_hash", 'sha256'), 'hex') THEN
    RAISE EXCEPTION 'Rule bundle does not accept approvals in status %', current_bundle."status";
  END IF;
  IF NEW."bundle_digest" <> current_bundle."bundle_digest" THEN
    RAISE EXCEPTION 'Rule bundle approval digest mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "rule_bundle_approvals_validate"
BEFORE INSERT ON "rule_bundle_approvals"
FOR EACH ROW EXECUTE FUNCTION "healthos_validate_rule_bundle_approval"();

CREATE FUNCTION "healthos_advance_rule_bundle_approval"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  approval_count integer;
  current_status "rule_bundle_status";
BEGIN
  SELECT count(*) INTO approval_count
  FROM "rule_bundle_approvals"
  WHERE "rule_bundle_id" = NEW."rule_bundle_id";

  SELECT "status" INTO current_status
  FROM "rule_bundles"
  WHERE "id" = NEW."rule_bundle_id";

  UPDATE "rule_bundles"
  SET "status" = CASE
    WHEN current_status = 'draft_unapproved' THEN 'approval_pending'::"rule_bundle_status"
    WHEN approval_count = 2 THEN 'approved_not_published'::"rule_bundle_status"
    ELSE 'approval_pending'::"rule_bundle_status"
  END
  WHERE "id" = NEW."rule_bundle_id";
  RETURN NEW;
END;
$$;

CREATE TRIGGER "rule_bundle_approvals_advance"
AFTER INSERT ON "rule_bundle_approvals"
FOR EACH ROW EXECUTE FUNCTION "healthos_advance_rule_bundle_approval"();

CREATE FUNCTION "healthos_validate_rule_bundle_update"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  approval_count integer;
BEGIN
  IF OLD."version" IS DISTINCT FROM NEW."version"
    OR OLD."content_hash" IS DISTINCT FROM NEW."content_hash"
    OR OLD."content_json" IS DISTINCT FROM NEW."content_json"
    OR OLD."bundle_digest" IS DISTINCT FROM NEW."bundle_digest"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'Rule bundle identity and content are immutable';
  END IF;

  IF OLD."status" <> NEW."status" AND NOT (
    (OLD."status" = 'draft_unapproved' AND NEW."status" = 'approval_pending') OR
    (OLD."status" = 'approval_pending' AND NEW."status" = 'approved_not_published') OR
    (OLD."status" = 'approved_not_published' AND NEW."status" = 'active') OR
    (OLD."status" = 'active' AND NEW."status" = 'superseded') OR
    (OLD."status" = 'active' AND NEW."status" = 'rolled_back') OR
    (OLD."status" IN ('superseded', 'rolled_back') AND NEW."status" = 'active')
  ) THEN
    RAISE EXCEPTION 'Invalid rule bundle status transition: % -> %', OLD."status", NEW."status";
  END IF;

  IF NEW."status" = 'active' THEN
    IF NEW."content_json" IS NULL
      OR NEW."content_hash" !~ '^[a-f0-9]{64}$'
      OR NEW."content_hash" <> encode(digest(NEW."content_json"::text, 'sha256'), 'hex')
      OR NOT (NEW."content_json" ?& ARRAY[
        'rules_engine', 'rules_engine_digest', 'safety_bundle_digest', 'localization_bundle_digest',
        'template_bundle_digest', 'beta_normal_review_percent', 'rules'
      ])
      OR NEW."content_json"->>'rules_engine' <> 'deterministic-rules-v1'
      OR NEW."content_json"->>'rules_engine_digest' <> '22e19a3848877f16f3a56921f91f8eb1f3a54f21551d3c47569153f748c8d282'
      OR NEW."content_json"->>'safety_bundle_digest' !~ '^[a-f0-9]{64}$'
      OR NEW."content_json"->>'localization_bundle_digest' !~ '^[a-f0-9]{64}$'
      OR NEW."content_json"->>'template_bundle_digest' !~ '^[a-f0-9]{64}$'
      OR (NEW."content_json"->>'beta_normal_review_percent') !~ '^[0-9]+$'
      OR (NEW."content_json"->>'beta_normal_review_percent')::integer NOT BETWEEN 20 AND 100
      OR NEW."bundle_digest" IS NULL
      OR NEW."bundle_digest" <> encode(digest(NEW."version" || ':' || NEW."content_hash", 'sha256'), 'hex') THEN
      RAISE EXCEPTION 'Active rule bundle identity is incomplete or invalid';
    END IF;
    SELECT count(*) INTO approval_count
    FROM "rule_bundle_approvals"
    WHERE "rule_bundle_id" = NEW."id"
      AND "bundle_digest" = NEW."bundle_digest";
    IF approval_count <> 2 THEN
      RAISE EXCEPTION 'Active rule bundle requires two digest-bound approvals';
    END IF;
    IF NEW."published_by" IS NULL OR NEW."published_at" IS NULL THEN
      RAISE EXCEPTION 'Active rule bundle requires publication audit fields';
    END IF;
  END IF;
  IF NEW."auto_publish_eligible" AND NEW."status" <> 'active' THEN
    RAISE EXCEPTION 'Only the active bundle can be auto-publish eligible';
  END IF;
  IF OLD."auto_publish_eligible" <> NEW."auto_publish_eligible" AND NOT (
    (OLD."status" = 'approved_not_published' AND NEW."status" = 'active') OR
    (OLD."status" = 'active' AND NEW."status" IN ('superseded', 'rolled_back')) OR
    (OLD."status" IN ('superseded', 'rolled_back') AND NEW."status" = 'active')
  ) THEN
    RAISE EXCEPTION 'Auto-publish eligibility changes only with an audited bundle transition';
  END IF;
  IF OLD."status" = NEW."status" AND (
    OLD."published_by" IS DISTINCT FROM NEW."published_by" OR
    OLD."published_at" IS DISTINCT FROM NEW."published_at" OR
    OLD."rolled_back_at" IS DISTINCT FROM NEW."rolled_back_at"
  ) THEN
    RAISE EXCEPTION 'Rule bundle publication audit fields are transition-bound';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "rule_bundles_validate_update"
BEFORE UPDATE ON "rule_bundles"
FOR EACH ROW EXECUTE FUNCTION "healthos_validate_rule_bundle_update"();

CREATE TRIGGER "rule_bundle_approvals_append_only"
BEFORE UPDATE OR DELETE ON "rule_bundle_approvals"
FOR EACH ROW EXECUTE FUNCTION "healthos_prevent_append_only_mutation"();

CREATE TABLE "rule_bundle_rollback_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "source_bundle_id" UUID NOT NULL,
  "target_bundle_id" UUID NOT NULL,
  "actor_id" TEXT NOT NULL,
  "reason_code" TEXT NOT NULL,
  "source_digest" TEXT NOT NULL,
  "target_digest" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "rule_bundle_rollback_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "rule_bundle_rollback_events_distinct" CHECK ("source_bundle_id" <> "target_bundle_id"),
  CONSTRAINT "rule_bundle_rollback_events_actor_reason" CHECK (
    length(trim("actor_id")) > 0 AND length(trim("reason_code")) > 0
  ),
  CONSTRAINT "rule_bundle_rollback_events_source_digest" CHECK ("source_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "rule_bundle_rollback_events_target_digest" CHECK ("target_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "rule_bundle_rollback_events_source_bundle_id_fkey"
    FOREIGN KEY ("source_bundle_id") REFERENCES "rule_bundles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "rule_bundle_rollback_events_target_bundle_id_fkey"
    FOREIGN KEY ("target_bundle_id") REFERENCES "rule_bundles"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "rule_bundle_rollback_events_source_bundle_id_created_at_idx"
ON "rule_bundle_rollback_events"("source_bundle_id", "created_at");

ALTER TABLE "rule_bundles"
ADD CONSTRAINT "rule_bundles_last_rollback_event_id_fkey"
FOREIGN KEY ("last_rollback_event_id") REFERENCES "rule_bundle_rollback_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "healthos_validate_rule_bundle_rollback_event"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_status "rule_bundle_status"; target_status "rule_bundle_status";
BEGIN
  SELECT "status" INTO source_status FROM "rule_bundles" WHERE "id" = NEW."source_bundle_id" FOR UPDATE;
  SELECT "status" INTO target_status FROM "rule_bundles" WHERE "id" = NEW."target_bundle_id" FOR UPDATE;
  IF source_status <> 'active' OR target_status NOT IN ('superseded', 'rolled_back') THEN
    RAISE EXCEPTION 'Rollback evidence source or target state is invalid';
  END IF;
  IF NEW."source_digest" <> (SELECT "bundle_digest" FROM "rule_bundles" WHERE "id" = NEW."source_bundle_id")
    OR NEW."target_digest" <> (SELECT "bundle_digest" FROM "rule_bundles" WHERE "id" = NEW."target_bundle_id") THEN
    RAISE EXCEPTION 'Rollback evidence digest mismatch';
  END IF;
  NEW."created_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "rule_bundle_rollback_events_validate"
BEFORE INSERT ON "rule_bundle_rollback_events"
FOR EACH ROW EXECUTE FUNCTION "healthos_validate_rule_bundle_rollback_event"();

CREATE TRIGGER "rule_bundle_rollback_events_append_only"
BEFORE UPDATE OR DELETE ON "rule_bundle_rollback_events"
FOR EACH ROW EXECUTE FUNCTION "healthos_prevent_append_only_mutation"();

CREATE FUNCTION "healthos_require_rule_bundle_rollback_event"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'active' AND NEW."status" = 'rolled_back' AND NOT EXISTS (
    SELECT 1 FROM "rule_bundle_rollback_events" e
    JOIN "rule_bundles" target ON target."id" = e."target_bundle_id"
    WHERE e."id" = NEW."last_rollback_event_id"
      AND e."source_bundle_id" = NEW."id" AND e."source_digest" = NEW."bundle_digest"
      AND e."created_at" >= transaction_timestamp()
      AND target."last_rollback_event_id" = e."id"
  ) THEN
    RAISE EXCEPTION 'Rule bundle rollback requires append-only evidence';
  END IF;
  IF OLD."status" IN ('superseded', 'rolled_back') AND NEW."status" = 'active' AND NOT EXISTS (
    SELECT 1 FROM "rule_bundle_rollback_events" e
    JOIN "rule_bundles" source ON source."id" = e."source_bundle_id"
    WHERE e."id" = NEW."last_rollback_event_id"
      AND e."target_bundle_id" = NEW."id" AND e."target_digest" = NEW."bundle_digest"
      AND e."created_at" >= transaction_timestamp()
      AND source."last_rollback_event_id" = e."id"
  ) THEN
    RAISE EXCEPTION 'Rule bundle reactivation requires rollback evidence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "rule_bundles_require_rollback_evidence"
AFTER UPDATE ON "rule_bundles"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "healthos_require_rule_bundle_rollback_event"();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "recommendation_runs"
    GROUP BY "user_id", "local_date"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Historical recommendation runs contain duplicate user/local_date rows';
  END IF;
END;
$$;

DROP INDEX "recommendation_runs_user_id_local_date_input_snapshot_id_ru_key";
CREATE UNIQUE INDEX "recommendation_runs_user_id_local_date_key"
ON "recommendation_runs"("user_id", "local_date");

CREATE UNIQUE INDEX "domain_outbox_one_recommendation_request_per_run_idx"
ON "domain_outbox"("aggregate_id") WHERE "event_type" = 'recommendation.run.requested';

CREATE UNIQUE INDEX "profile_snapshots_id_user_id_consent_epoch_key"
ON "profile_snapshots"("id", "user_id", "consent_epoch");

ALTER TABLE "recommendation_runs"
  ADD COLUMN "consent_epoch" INTEGER,
  ADD COLUMN "input_hash" TEXT,
  ADD COLUMN "input_manifest_json" JSONB,
  ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lease_token" TEXT,
  ADD COLUMN "lease_until" TIMESTAMPTZ(6);

UPDATE "recommendation_runs" r
SET "consent_epoch" = p."consent_epoch"
FROM "profile_snapshots" p
WHERE p."id" = r."input_snapshot_id";

UPDATE "recommendation_runs"
SET "status" = 'suppressed', "lease_token" = NULL, "lease_until" = NULL
WHERE "input_manifest_json" IS NULL;

ALTER TABLE "recommendation_runs" ALTER COLUMN "consent_epoch" SET NOT NULL;

ALTER TABLE "recommendation_runs"
  DROP CONSTRAINT "recommendation_runs_input_snapshot_id_fkey",
  ADD CONSTRAINT "recommendation_runs_input_snapshot_id_user_id_consent_epoc_fkey"
    FOREIGN KEY ("input_snapshot_id", "user_id", "consent_epoch")
    REFERENCES "profile_snapshots"("id", "user_id", "consent_epoch")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "recommendation_runs_attempt_nonnegative" CHECK ("attempt" >= 0),
  ADD CONSTRAINT "recommendation_runs_lease_shape" CHECK (
    ("status" = 'active' AND "lease_token" IS NOT NULL AND "lease_until" IS NOT NULL)
    OR ("status" <> 'active' AND "lease_token" IS NULL AND "lease_until" IS NULL)
  );

ALTER TABLE "recommendation_runs"
  ADD CONSTRAINT "recommendation_runs_input_hash_sha256"
  CHECK ("input_hash" IS NULL OR "input_hash" ~ '^[a-f0-9]{64}$');

ALTER TABLE "recommendation_runs" ALTER COLUMN "consent_epoch" DROP DEFAULT;

CREATE FUNCTION "healthos_derive_recommendation_run_input_hash"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest_profile_id UUID;
BEGIN
  IF NEW."input_manifest_json" IS NULL THEN
    RAISE EXCEPTION 'New recommendation run requires an immutable input manifest';
  END IF;
  SELECT "id" INTO latest_profile_id
  FROM "profile_snapshots"
  WHERE "user_id" = NEW."user_id" AND "consent_epoch" = NEW."consent_epoch"
  ORDER BY "version" DESC LIMIT 1;
  IF latest_profile_id IS NULL OR latest_profile_id <> NEW."input_snapshot_id" THEN
    RAISE EXCEPTION 'Recommendation run requires the latest current profile snapshot';
  END IF;
  NEW."input_hash" := encode(digest(NEW."input_manifest_json"::text, 'sha256'), 'hex');
  RETURN NEW;
END;
$$;

CREATE TRIGGER "recommendation_runs_derive_input_hash"
BEFORE INSERT ON "recommendation_runs"
FOR EACH ROW EXECUTE FUNCTION "healthos_derive_recommendation_run_input_hash"();

CREATE TABLE "recommendation_run_fact_inputs" (
  "run_id" UUID NOT NULL,
  "fact_revision_id" UUID NOT NULL,
  "input_hash" TEXT NOT NULL,
  CONSTRAINT "recommendation_run_fact_inputs_pkey" PRIMARY KEY ("run_id", "fact_revision_id"),
  CONSTRAINT "recommendation_run_fact_inputs_hash" CHECK ("input_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "recommendation_run_fact_inputs_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "recommendation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "recommendation_run_fact_inputs_fact_revision_id_fkey"
    FOREIGN KEY ("fact_revision_id") REFERENCES "daily_health_fact_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "recommendation_run_lab_inputs" (
  "run_id" UUID NOT NULL,
  "lab_observation_id" UUID NOT NULL,
  "observation_hash" TEXT NOT NULL,
  CONSTRAINT "recommendation_run_lab_inputs_pkey" PRIMARY KEY ("run_id", "lab_observation_id"),
  CONSTRAINT "recommendation_run_lab_inputs_hash" CHECK ("observation_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "recommendation_run_lab_inputs_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "recommendation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "recommendation_run_lab_inputs_lab_observation_id_fkey"
    FOREIGN KEY ("lab_observation_id") REFERENCES "lab_observations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

ALTER TABLE "recommendation_snapshots" DISABLE TRIGGER "recommendation_snapshots_append_only";
UPDATE "recommendation_snapshots"
SET "review_status" = 'blocked'
WHERE "review_status" = 'published';
ALTER TABLE "recommendation_snapshots" ENABLE TRIGGER "recommendation_snapshots_append_only";

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'recommendation_snapshots'::regclass
      AND tgname = 'recommendation_snapshots_append_only' AND tgenabled = 'O'
  ) THEN RAISE EXCEPTION 'Recommendation snapshot append-only trigger was not restored'; END IF;
END;
$$;

ALTER TABLE "recommendation_snapshots"
  ALTER COLUMN "risk_area" DROP NOT NULL,
  ALTER COLUMN "action_code" DROP NOT NULL,
  ADD COLUMN "snapshot_hash" TEXT,
  ADD COLUMN "release_stage" TEXT,
  ADD COLUMN "review_route" TEXT,
  ADD COLUMN "policy_digest" TEXT,
  ADD COLUMN "sampling_bucket" INTEGER,
  ADD COLUMN "review_sample_percent" INTEGER;

ALTER TABLE "recommendation_snapshots"
  ADD CONSTRAINT "recommendation_snapshots_hash_sha256"
  CHECK ("snapshot_hash" IS NULL OR "snapshot_hash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "recommendation_snapshots_safety_class" CHECK ("safety_class" IN ('normal', 'caution', 'doctor', 'blocked')),
  ADD CONSTRAINT "recommendation_snapshots_release_stage" CHECK ("release_stage" IS NULL OR "release_stage" IN ('alpha', 'beta')),
  ADD CONSTRAINT "recommendation_snapshots_review_route" CHECK ("review_route" IS NULL OR "review_route" IN ('review_required', 'auto_publish', 'fixed_fallback', 'blocked')),
  ADD CONSTRAINT "recommendation_snapshots_sampling_bucket" CHECK ("sampling_bucket" IS NULL OR "sampling_bucket" BETWEEN 0 AND 99),
  ADD CONSTRAINT "recommendation_snapshots_review_sample_percent" CHECK (
    "review_sample_percent" IS NULL OR "review_sample_percent" BETWEEN 20 AND 100
  );

CREATE UNIQUE INDEX "recommendation_snapshots_one_published_per_run_idx"
ON "recommendation_snapshots"("run_id") WHERE "review_status" = 'published';

CREATE UNIQUE INDEX "recommendation_snapshots_supersedes_id_key"
ON "recommendation_snapshots"("supersedes_id") WHERE "supersedes_id" IS NOT NULL;

ALTER TABLE "recommendation_snapshots"
  DROP CONSTRAINT "recommendation_snapshots_supersedes_id_fkey",
  ADD CONSTRAINT "recommendation_snapshots_supersedes_id_fkey"
    FOREIGN KEY ("supersedes_id") REFERENCES "recommendation_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "action_assignments"
  DROP CONSTRAINT "action_assignments_recommendation_snapshot_id_fkey",
  ADD CONSTRAINT "action_assignments_recommendation_snapshot_id_fkey"
    FOREIGN KEY ("recommendation_snapshot_id") REFERENCES "recommendation_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "healthos_validate_recommendation_supersession"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous_run UUID;
  previous_revision INTEGER;
BEGIN
  IF NEW."revision" = 1 THEN
    IF NEW."supersedes_id" IS NOT NULL THEN
      RAISE EXCEPTION 'First recommendation revision cannot supersede another snapshot';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."supersedes_id" IS NULL THEN
    RAISE EXCEPTION 'Recommendation revision % requires a predecessor', NEW."revision";
  END IF;
  SELECT "run_id", "revision" INTO previous_run, previous_revision
  FROM "recommendation_snapshots"
  WHERE "id" = NEW."supersedes_id";
  IF previous_run IS NULL OR previous_run <> NEW."run_id" OR previous_revision <> NEW."revision" - 1 THEN
    RAISE EXCEPTION 'Recommendation revision must directly supersede the prior revision in the same run';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE "recommendation_review_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "snapshot_id" UUID NOT NULL,
  "event_type" "recommendation_review_event_type" NOT NULL,
  "actor_id" TEXT,
  "reason_code" TEXT,
  "from_snapshot_id" UUID,
  "to_snapshot_id" UUID,
  "before_hash" TEXT,
  "after_hash" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "recommendation_review_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recommendation_review_events_snapshot_id_fkey"
    FOREIGN KEY ("snapshot_id") REFERENCES "recommendation_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "recommendation_review_events_from_snapshot_id_fkey"
    FOREIGN KEY ("from_snapshot_id") REFERENCES "recommendation_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "recommendation_review_events_to_snapshot_id_fkey"
    FOREIGN KEY ("to_snapshot_id") REFERENCES "recommendation_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "recommendation_review_events_edit_reason" CHECK (
    "event_type" <> 'edited' OR
    (
      length(trim(coalesce("reason_code", ''))) > 0 AND
      "from_snapshot_id" IS NOT NULL AND
      "to_snapshot_id" IS NOT NULL AND
      "from_snapshot_id" <> "to_snapshot_id"
    )
  ),
  CONSTRAINT "recommendation_review_events_actor_required" CHECK (
    "event_type" NOT IN ('approved', 'edited', 'rejected') OR
    length(trim(coalesce("actor_id", ''))) > 0
  )
);

CREATE INDEX "recommendation_review_events_snapshot_id_created_at_idx"
ON "recommendation_review_events"("snapshot_id", "created_at");
CREATE UNIQUE INDEX "recommendation_review_events_to_snapshot_id_event_type_key"
ON "recommendation_review_events"("to_snapshot_id", "event_type");

CREATE FUNCTION "healthos_validate_recommendation_review_event"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  from_run UUID; to_run UUID; from_revision INTEGER; to_revision INTEGER;
  from_hash TEXT; to_hash TEXT;
  from_status "recommendation_review_status"; to_status "recommendation_review_status";
BEGIN
  NEW."created_at" := clock_timestamp();
  IF NEW."event_type" IN ('approved', 'edited') THEN
    SELECT "run_id", "revision", "snapshot_hash", "review_status"
    INTO from_run, from_revision, from_hash, from_status
    FROM "recommendation_snapshots" WHERE "id" = NEW."from_snapshot_id";
    SELECT "run_id", "revision", "snapshot_hash", "review_status"
    INTO to_run, to_revision, to_hash, to_status
    FROM "recommendation_snapshots" WHERE "id" = NEW."to_snapshot_id";
    IF from_run IS NULL OR to_run <> from_run OR to_revision <> from_revision + 1
      OR NEW."snapshot_id" <> NEW."to_snapshot_id"
      OR from_status <> 'review_required' OR to_status <> 'published'
      OR NEW."before_hash" IS DISTINCT FROM from_hash
      OR NEW."after_hash" IS DISTINCT FROM to_hash THEN
      RAISE EXCEPTION 'Recommendation review evidence does not bind adjacent immutable revisions';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "recommendation_review_events_validate"
BEFORE INSERT ON "recommendation_review_events"
FOR EACH ROW EXECUTE FUNCTION "healthos_validate_recommendation_review_event"();

CREATE TRIGGER "recommendation_review_events_append_only"
BEFORE UPDATE OR DELETE ON "recommendation_review_events"
FOR EACH ROW EXECUTE FUNCTION "healthos_prevent_append_only_mutation"();

CREATE TABLE "recommendation_review_tasks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "snapshot_id" UUID NOT NULL,
  "priority" TEXT NOT NULL,
  "status" "record_status" NOT NULL DEFAULT 'pending',
  "sla_at" TIMESTAMPTZ(6) NOT NULL,
  "reason_code" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "recommendation_review_tasks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recommendation_review_tasks_snapshot_id_fkey"
    FOREIGN KEY ("snapshot_id") REFERENCES "recommendation_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "recommendation_review_tasks_status_priority_sla_at_idx"
ON "recommendation_review_tasks"("status", "priority", "sla_at");
CREATE UNIQUE INDEX "recommendation_review_tasks_snapshot_id_key"
ON "recommendation_review_tasks"("snapshot_id");

CREATE TABLE "recommendation_publications" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "snapshot_id" UUID NOT NULL,
  "action_assignment_id" UUID,
  "domain_outbox_id" UUID NOT NULL,
  "audit_log_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "recommendation_publications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recommendation_publications_snapshot_id_key" UNIQUE ("snapshot_id"),
  CONSTRAINT "recommendation_publications_action_assignment_id_key" UNIQUE ("action_assignment_id"),
  CONSTRAINT "recommendation_publications_domain_outbox_id_key" UNIQUE ("domain_outbox_id"),
  CONSTRAINT "recommendation_publications_audit_log_id_key" UNIQUE ("audit_log_id"),
  CONSTRAINT "recommendation_publications_snapshot_id_fkey"
    FOREIGN KEY ("snapshot_id") REFERENCES "recommendation_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "recommendation_publications_action_assignment_id_fkey"
    FOREIGN KEY ("action_assignment_id") REFERENCES "action_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "recommendation_publications_domain_outbox_id_fkey"
    FOREIGN KEY ("domain_outbox_id") REFERENCES "domain_outbox"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "recommendation_publications_audit_log_id_fkey"
    FOREIGN KEY ("audit_log_id") REFERENCES "audit_logs"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "recommendation_publication_channels" (
  "publication_id" UUID NOT NULL,
  "channel_outbox_id" UUID NOT NULL,
  CONSTRAINT "recommendation_publication_channels_pkey" PRIMARY KEY ("publication_id", "channel_outbox_id"),
  CONSTRAINT "recommendation_publication_channels_channel_outbox_id_key" UNIQUE ("channel_outbox_id"),
  CONSTRAINT "recommendation_publication_channels_publication_id_fkey"
    FOREIGN KEY ("publication_id") REFERENCES "recommendation_publications"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "recommendation_publication_channels_channel_outbox_id_fkey"
    FOREIGN KEY ("channel_outbox_id") REFERENCES "channel_outbox"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE FUNCTION "healthos_validate_recommendation_run_update"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."user_id" IS DISTINCT FROM NEW."user_id"
    OR OLD."local_date" IS DISTINCT FROM NEW."local_date"
    OR OLD."input_snapshot_id" IS DISTINCT FROM NEW."input_snapshot_id"
    OR OLD."rule_bundle_id" IS DISTINCT FROM NEW."rule_bundle_id"
    OR OLD."consent_epoch" IS DISTINCT FROM NEW."consent_epoch"
    OR OLD."input_hash" IS DISTINCT FROM NEW."input_hash"
    OR OLD."input_manifest_json" IS DISTINCT FROM NEW."input_manifest_json"
    OR OLD."correlation_id" IS DISTINCT FROM NEW."correlation_id" THEN
    RAISE EXCEPTION 'Recommendation run identity and inputs are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "recommendation_runs_identity_immutable"
BEFORE UPDATE ON "recommendation_runs"
FOR EACH ROW EXECUTE FUNCTION "healthos_validate_recommendation_run_update"();

CREATE FUNCTION "healthos_derive_recommendation_snapshot_hash"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."provenance_json" := jsonb_set(
    NEW."provenance_json",
    '{rendered_payload_hash}',
    to_jsonb(encode(digest(NEW."rendered_payload_json"::text, 'sha256'), 'hex')),
    true
  );
  NEW."snapshot_hash" := encode(digest(jsonb_build_object(
    'run_id', NEW."run_id",
    'revision', NEW."revision",
    'risk_area', NEW."risk_area",
    'safety_class', NEW."safety_class",
    'action_code', NEW."action_code",
    'rendered_payload', NEW."rendered_payload_json",
    'canonical_rule_input', NEW."canonical_rule_input_json",
    'provenance', NEW."provenance_json",
    'review_status', NEW."review_status",
    'supersedes_id', NEW."supersedes_id",
    'release_stage', NEW."release_stage",
    'review_route', NEW."review_route",
    'policy_digest', NEW."policy_digest",
    'sampling_bucket', NEW."sampling_bucket",
    'review_sample_percent', NEW."review_sample_percent"
  )::text, 'sha256'), 'hex');
  RETURN NEW;
END;
$$;

CREATE TRIGGER "recommendation_snapshots_derive_hash"
BEFORE INSERT ON "recommendation_snapshots"
FOR EACH ROW EXECUTE FUNCTION "healthos_derive_recommendation_snapshot_hash"();

CREATE FUNCTION "healthos_validate_recommendation_fact_input"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  run_user UUID;
  run_date DATE;
  fact_user UUID;
  fact_date DATE;
  fact_hash TEXT;
BEGIN
  SELECT "user_id", "local_date" INTO run_user, run_date
  FROM "recommendation_runs" WHERE "id" = NEW."run_id";
  SELECT "user_id", "local_date", "input_hash" INTO fact_user, fact_date, fact_hash
  FROM "daily_health_fact_revisions" WHERE "id" = NEW."fact_revision_id";
  IF run_user IS NULL OR fact_user <> run_user OR fact_date > run_date OR fact_hash <> NEW."input_hash" THEN
    RAISE EXCEPTION 'Recommendation fact input provenance mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "recommendation_run_fact_inputs_validate"
BEFORE INSERT ON "recommendation_run_fact_inputs"
FOR EACH ROW EXECUTE FUNCTION "healthos_validate_recommendation_fact_input"();

CREATE FUNCTION "healthos_validate_recommendation_lab_input"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  run_user UUID;
  lab_user UUID;
  lab_status "confirmation_status";
  expected_hash TEXT;
BEGIN
  SELECT "user_id" INTO run_user FROM "recommendation_runs" WHERE "id" = NEW."run_id";
  SELECT d."user_id", o."confirmation_status",
    encode(digest(jsonb_build_object(
      'id', o."id", 'document_id', o."document_id", 'code', o."code",
      'value', o."value", 'unit', o."unit", 'normalized_value', o."normalized_value",
      'reference_range', o."reference_range", 'page', o."page",
      'evidence_box', o."evidence_box", 'confidence', o."confidence",
      'confirmation_status', o."confirmation_status"
    )::text, 'sha256'), 'hex')
  INTO lab_user, lab_status, expected_hash
  FROM "lab_observations" o
  JOIN "lab_documents" d ON d."id" = o."document_id"
  WHERE o."id" = NEW."lab_observation_id";
  IF run_user IS NULL OR lab_user <> run_user OR lab_status <> 'usable' OR expected_hash <> NEW."observation_hash" THEN
    RAISE EXCEPTION 'Recommendation lab input provenance mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "recommendation_run_lab_inputs_validate"
BEFORE INSERT ON "recommendation_run_lab_inputs"
FOR EACH ROW EXECUTE FUNCTION "healthos_validate_recommendation_lab_input"();

CREATE FUNCTION "healthos_assert_recommendation_run_manifest"(target_run_id UUID)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  run_row "recommendation_runs"%ROWTYPE;
  profile_row "profile_snapshots"%ROWTYPE;
  bundle_row "rule_bundles"%ROWTYPE;
  expected_fact_inputs JSONB;
  expected_lab_inputs JSONB;
BEGIN
  SELECT * INTO run_row FROM "recommendation_runs" WHERE "id" = target_run_id;
  IF run_row."id" IS NULL OR run_row."input_manifest_json" IS NULL THEN
    RAISE EXCEPTION 'Recommendation run manifest is required';
  END IF;
  SELECT * INTO profile_row FROM "profile_snapshots" WHERE "id" = run_row."input_snapshot_id";
  SELECT * INTO bundle_row FROM "rule_bundles" WHERE "id" = run_row."rule_bundle_id";
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', "fact_revision_id"::text, 'input_hash', "input_hash"
    ) ORDER BY "fact_revision_id"), '[]'::jsonb)
  INTO expected_fact_inputs
  FROM "recommendation_run_fact_inputs" WHERE "run_id" = run_row."id";
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', "lab_observation_id"::text, 'observation_hash', "observation_hash"
    ) ORDER BY "lab_observation_id"), '[]'::jsonb)
  INTO expected_lab_inputs
  FROM "recommendation_run_lab_inputs" WHERE "run_id" = run_row."id";

  IF EXISTS (
      SELECT 1 FROM jsonb_object_keys(run_row."input_manifest_json") key
      WHERE key NOT IN (
        'profile_snapshot_id', 'profile_snapshot_hash', 'consent_epoch', 'rule_input',
        'fact_inputs', 'lab_inputs', 'rule_bundle_id', 'rule_bundle_digest'
      )
    )
    OR run_row."input_manifest_json"->>'profile_snapshot_id' IS DISTINCT FROM profile_row."id"::text
    OR run_row."input_manifest_json"->>'profile_snapshot_hash' IS DISTINCT FROM profile_row."snapshot_hash"
    OR run_row."input_manifest_json"->>'consent_epoch' IS DISTINCT FROM run_row."consent_epoch"::text
    OR run_row."input_manifest_json"->'rule_input' IS DISTINCT FROM profile_row."facts_json"->'rule_input'
    OR run_row."input_manifest_json"->'fact_inputs' IS DISTINCT FROM expected_fact_inputs
    OR run_row."input_manifest_json"->'lab_inputs' IS DISTINCT FROM expected_lab_inputs
    OR run_row."input_manifest_json"->>'rule_bundle_id' IS DISTINCT FROM bundle_row."id"::text
    OR run_row."input_manifest_json"->>'rule_bundle_digest' IS DISTINCT FROM bundle_row."bundle_digest" THEN
    RAISE EXCEPTION 'Recommendation run manifest does not match immutable source rows';
  END IF;
END;
$$;

CREATE FUNCTION "healthos_validate_recommendation_run_manifest"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "healthos_assert_recommendation_run_manifest"(NEW."id");
  RETURN NEW;
END;
$$;

CREATE FUNCTION "healthos_validate_recommendation_sidecar_manifest"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "healthos_assert_recommendation_run_manifest"(NEW."run_id");
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "recommendation_runs_manifest_binding"
AFTER INSERT ON "recommendation_runs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "healthos_validate_recommendation_run_manifest"();

CREATE CONSTRAINT TRIGGER "recommendation_fact_inputs_manifest_binding"
AFTER INSERT ON "recommendation_run_fact_inputs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "healthos_validate_recommendation_sidecar_manifest"();

CREATE CONSTRAINT TRIGGER "recommendation_lab_inputs_manifest_binding"
AFTER INSERT ON "recommendation_run_lab_inputs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "healthos_validate_recommendation_sidecar_manifest"();

CREATE FUNCTION "healthos_recommendation_sampling_bucket"(
  target_user_id UUID,
  target_local_date DATE,
  target_signal TEXT
)
RETURNS INTEGER
LANGUAGE SQL
IMMUTABLE
STRICT
AS $$
  SELECT ((('x' || substr(encode(digest(
    target_user_id::text || ':' || target_local_date::text || ':' || target_signal,
    'sha256'
  ), 'hex'), 1, 8))::bit(32)::bigint) % 100)::integer
$$;

CREATE FUNCTION "healthos_protect_safety_incident"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."user_id" IS NOT NULL THEN
      PERFORM 1 FROM "users" WHERE "id" = NEW."user_id" FOR KEY SHARE;
    END IF;
    IF NEW."source" LIKE 'rule:%' THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(NEW."source", 0));
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
    AND OLD."user_id" IS NOT NULL AND NEW."user_id" IS NULL
    AND OLD."source" IS NOT DISTINCT FROM NEW."source"
    AND OLD."severity" IS NOT DISTINCT FROM NEW."severity"
    AND OLD."status" IS NOT DISTINCT FROM NEW."status"
    AND OLD."details_encrypted" IS NOT DISTINCT FROM NEW."details_encrypted"
    AND OLD."created_at" IS NOT DISTINCT FROM NEW."created_at"
    AND EXISTS (
      SELECT 1 FROM "healthos_private"."privacy_delete_authorizations"
      WHERE "transaction_id" = txid_current() AND "user_id" = OLD."user_id"
    ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Safety incidents are append-only; append a follow-up incident event';
END;
$$;

CREATE TRIGGER "safety_incidents_append_only"
BEFORE INSERT OR UPDATE OR DELETE ON "safety_incidents"
FOR EACH ROW EXECUTE FUNCTION "healthos_protect_safety_incident"();

CREATE FUNCTION "healthos_validate_recommendation_publication"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  publication_row "recommendation_publications"%ROWTYPE;
  run_row "recommendation_runs"%ROWTYPE;
  user_row "users"%ROWTYPE;
  bundle_row "rule_bundles"%ROWTYPE;
  latest_consent "consent_records"%ROWTYPE;
  domain_row "domain_outbox"%ROWTYPE;
  channel_count integer;
  action_count integer;
  profile_hash TEXT;
  latest_profile_id UUID;
  expected_fact_ids JSONB;
  expected_fact_hashes JSONB;
  expected_lab_ids JSONB;
  expected_lab_hashes JSONB;
  stored_rule_input JSONB;
  expected_sample_percent INTEGER;
  expected_sampling_bucket INTEGER;
BEGIN
  IF NEW."review_status" <> 'published' THEN RETURN NEW; END IF;
  IF NEW."safety_class" = 'blocked' OR NEW."review_route" = 'blocked' THEN
    RAISE EXCEPTION 'Blocked recommendation cannot publish';
  END IF;
  IF NEW."snapshot_hash" IS NULL OR NEW."policy_digest" IS NULL
    OR NEW."release_stage" IS NULL OR NEW."review_route" IS NULL THEN
    RAISE EXCEPTION 'Published recommendation identity is incomplete';
  END IF;
  IF NOT (NEW."provenance_json" ?& ARRAY[
    'profile_snapshot_id', 'profile_snapshot_hash', 'daily_fact_revision_ids',
    'daily_fact_input_hashes', 'lab_observation_ids', 'lab_observation_hashes',
    'rule_bundle_id', 'rule_bundle_digest', 'rules_engine', 'rules_engine_digest',
    'safety_bundle', 'localization_bundle',
    'template_bundle', 'prompt_version', 'provider_id', 'model_id',
    'rendered_payload_hash', 'generated_at', 'rule_result', 'rule_key'
  ]) THEN
    RAISE EXCEPTION 'Published recommendation provenance is incomplete';
  END IF;

  SELECT * INTO publication_row FROM "recommendation_publications" WHERE "snapshot_id" = NEW."id";
  IF publication_row."id" IS NULL THEN RAISE EXCEPTION 'Published recommendation requires a publication manifest'; END IF;
  SELECT * INTO run_row FROM "recommendation_runs" WHERE "id" = NEW."run_id";
  SELECT * INTO user_row FROM "users" WHERE "id" = run_row."user_id" FOR KEY SHARE;
  SELECT * INTO bundle_row FROM "rule_bundles" WHERE "id" = run_row."rule_bundle_id";
  SELECT * INTO domain_row FROM "domain_outbox" WHERE "id" = publication_row."domain_outbox_id";
  SELECT * INTO latest_consent FROM "consent_records"
    WHERE "user_id" = run_row."user_id" AND "consent_type" = 'health_processing'
    ORDER BY "epoch" DESC LIMIT 1;

  IF run_row."status" <> 'completed' OR run_row."input_hash" IS NULL THEN
    RAISE EXCEPTION 'Published recommendation run is not complete';
  END IF;
  IF user_row."status" <> 'active' OR user_row."deleted_at" IS NOT NULL
    OR latest_consent."granted" IS DISTINCT FROM true
    OR latest_consent."epoch" <> run_row."consent_epoch"
    OR NOT EXISTS (SELECT 1 FROM "privacy_reconciliation" WHERE "id" = 'global' AND "status" = 'ready') THEN
    RAISE EXCEPTION 'Published recommendation lacks current user authorization';
  END IF;
  IF bundle_row."status" <> 'active' OR bundle_row."bundle_digest" IS NULL
    OR NEW."provenance_json"->>'rule_bundle_id' <> bundle_row."id"::text
    OR NEW."provenance_json"->>'rule_bundle_digest' <> bundle_row."bundle_digest" THEN
    RAISE EXCEPTION 'Published recommendation bundle is not active or does not match provenance';
  END IF;
  IF NEW."provenance_json"->>'rules_engine' IS DISTINCT FROM bundle_row."content_json"->>'rules_engine'
    OR NEW."provenance_json"->>'rules_engine_digest' IS DISTINCT FROM bundle_row."content_json"->>'rules_engine_digest'
    OR NEW."provenance_json"->>'safety_bundle' IS DISTINCT FROM bundle_row."content_json"->>'safety_bundle_digest'
    OR NEW."provenance_json"->>'localization_bundle' IS DISTINCT FROM bundle_row."content_json"->>'localization_bundle_digest'
    OR NEW."provenance_json"->>'template_bundle' IS DISTINCT FROM bundle_row."content_json"->>'template_bundle_digest' THEN
    RAISE EXCEPTION 'Published recommendation policy bundle identities do not match active content';
  END IF;

  SELECT "snapshot_hash" INTO profile_hash
  FROM "profile_snapshots" WHERE "id" = run_row."input_snapshot_id";
  SELECT "id" INTO latest_profile_id
  FROM "profile_snapshots"
  WHERE "user_id" = run_row."user_id" AND "consent_epoch" = run_row."consent_epoch"
  ORDER BY "version" DESC LIMIT 1;
  SELECT COALESCE(jsonb_agg("fact_revision_id"::text ORDER BY "fact_revision_id"), '[]'::jsonb),
         COALESCE(jsonb_agg("input_hash" ORDER BY "fact_revision_id"), '[]'::jsonb)
    INTO expected_fact_ids, expected_fact_hashes
  FROM "recommendation_run_fact_inputs" WHERE "run_id" = run_row."id";
  SELECT COALESCE(jsonb_agg("lab_observation_id"::text ORDER BY "lab_observation_id"), '[]'::jsonb),
         COALESCE(jsonb_agg("observation_hash" ORDER BY "lab_observation_id"), '[]'::jsonb)
    INTO expected_lab_ids, expected_lab_hashes
  FROM "recommendation_run_lab_inputs" WHERE "run_id" = run_row."id";
  stored_rule_input := run_row."input_manifest_json"->'rule_input';
  IF latest_profile_id IS DISTINCT FROM run_row."input_snapshot_id"
    OR NEW."provenance_json"->>'profile_snapshot_id' <> run_row."input_snapshot_id"::text
    OR NEW."provenance_json"->>'profile_snapshot_hash' <> profile_hash
    OR NEW."provenance_json"->'daily_fact_revision_ids' <> expected_fact_ids
    OR NEW."provenance_json"->'daily_fact_input_hashes' <> expected_fact_hashes
    OR NEW."provenance_json"->'lab_observation_ids' <> expected_lab_ids
    OR NEW."provenance_json"->'lab_observation_hashes' <> expected_lab_hashes
    OR NEW."canonical_rule_input_json" <> stored_rule_input THEN
    RAISE EXCEPTION 'Published recommendation source provenance does not match immutable run inputs';
  END IF;
  IF NEW."provenance_json"->>'rendered_payload_hash' <>
      encode(digest(NEW."rendered_payload_json"::text, 'sha256'), 'hex')
    OR NEW."provenance_json"->'rule_result'->>'safetyClass' IS DISTINCT FROM NEW."safety_class"
    OR NEW."provenance_json"->'rule_result'->>'actionCode' IS DISTINCT FROM NEW."action_code"
    OR NEW."provenance_json"->'rule_result'->>'riskArea' IS DISTINCT FROM NEW."risk_area"
    OR NEW."rendered_payload_json"->>'safety_class' <> NEW."safety_class"
    OR NEW."rendered_payload_json"->>'action_code' IS DISTINCT FROM NEW."action_code"
    OR NEW."rendered_payload_json"->>'risk_area' IS DISTINCT FROM NEW."risk_area" THEN
    RAISE EXCEPTION 'Published recommendation rendered payload or rule result diverges from deterministic output';
  END IF;
  IF NEW."action_code" IS NOT NULL AND (
    NEW."provenance_json"->'rule_result'->>'outcome' IS DISTINCT FROM 'action'
    OR
    NOT (NEW."rendered_payload_json" ?& ARRAY['template', 'action_code', 'safety_class', 'risk_area'])
    OR
    NEW."rendered_payload_json"->>'template' <> 'daily_action_v1'
    OR NEW."provenance_json"->>'rule_key' <> (NEW."risk_area" || ':' || NEW."action_code")
    OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(NEW."rendered_payload_json") key
      WHERE key NOT IN ('template', 'action_code', 'safety_class', 'risk_area', 'copy_key')
    )
    OR (NEW."rendered_payload_json" ? 'copy_key' AND NEW."rendered_payload_json"->>'copy_key' !~ '^review\.[a-z0-9_.-]+$')
  ) THEN RAISE EXCEPTION 'Action payload exceeds the reviewed deterministic schema'; END IF;
  IF NEW."safety_class" = 'doctor' AND (
    NEW."provenance_json"->'rule_result'->>'outcome' IS DISTINCT FROM 'doctor'
    OR NOT (NEW."rendered_payload_json" ?& ARRAY['template', 'action_code', 'safety_class'])
    OR NEW."rendered_payload_json"->>'template' <> 'doctor_fixed_boundary_v1'
    OR NEW."action_code" IS NOT NULL OR NEW."risk_area" IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(NEW."rendered_payload_json") key
      WHERE key NOT IN ('template', 'action_code', 'safety_class')
    )
  ) THEN RAISE EXCEPTION 'Doctor output must use the fixed boundary template'; END IF;
  IF NEW."action_code" IS NULL AND NEW."safety_class" <> 'doctor' AND (
    NEW."provenance_json"->'rule_result'->>'outcome' IS DISTINCT FROM 'insufficient_data'
    OR NOT (NEW."rendered_payload_json" ?& ARRAY['template', 'action_code', 'safety_class', 'reason_code'])
    OR NEW."rendered_payload_json"->>'template' <> 'no_action_v1'
    OR NEW."rendered_payload_json"->>'reason_code' IS DISTINCT FROM NEW."provenance_json"->'rule_result'->>'reasonCode'
    OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(NEW."rendered_payload_json") key
      WHERE key NOT IN ('template', 'action_code', 'safety_class', 'reason_code')
    )
  ) THEN RAISE EXCEPTION 'No-action output exceeds the deterministic fallback schema'; END IF;

  IF domain_row."aggregate_id" <> NEW."id" OR domain_row."user_id" <> run_row."user_id"
    OR domain_row."event_type" <> 'recommendation.published'
    OR NOT EXISTS (
      SELECT 1 FROM "domain_outbox_consent_requirements"
      WHERE "outbox_id" = domain_row."id" AND "purpose" = 'health_processing'
        AND "grant_epoch" = run_row."consent_epoch"
    ) THEN
    RAISE EXCEPTION 'Published recommendation domain outbox is incomplete';
  END IF;

  SELECT count(*) INTO channel_count
  FROM "recommendation_publication_channels" pc
  JOIN "channel_outbox" co ON co."id" = pc."channel_outbox_id"
  WHERE pc."publication_id" = publication_row."id"
    AND co."user_id" = run_row."user_id"
    AND EXISTS (
      SELECT 1 FROM "channel_outbox_consent_requirements" cr
      WHERE cr."outbox_id" = co."id" AND cr."purpose" = 'health_processing'
        AND cr."grant_epoch" = run_row."consent_epoch"
    );
  IF channel_count < 1 THEN RAISE EXCEPTION 'Published recommendation requires an authorized channel outbox'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "audit_logs" WHERE "id" = publication_row."audit_log_id"
      AND "resource_type" = 'recommendation_snapshot' AND "resource_id" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'Published recommendation requires audit evidence';
  END IF;

  SELECT count(*) INTO action_count FROM "action_assignments"
  WHERE "id" = publication_row."action_assignment_id"
    AND "recommendation_snapshot_id" = NEW."id"
    AND "user_id" = run_row."user_id" AND "local_date" = run_row."local_date";
  IF NEW."action_code" IS NOT NULL AND action_count <> 1 THEN
    RAISE EXCEPTION 'Action recommendation requires a matching assignment';
  END IF;
  IF NEW."action_code" IS NULL AND publication_row."action_assignment_id" IS NOT NULL THEN
    RAISE EXCEPTION 'Fallback recommendation cannot create an action assignment';
  END IF;

  IF NEW."review_route" = 'review_required' AND NOT EXISTS (
    SELECT 1
    FROM "recommendation_review_events" e
    JOIN "recommendation_review_tasks" t ON t."snapshot_id" = e."from_snapshot_id"
    WHERE e."snapshot_id" = NEW."id" AND e."event_type" = 'approved'
      AND t."status" = 'completed' AND e."created_at" <= t."sla_at"
  ) THEN RAISE EXCEPTION 'Reviewed recommendation requires an in-SLA approval and completed task'; END IF;
  IF NEW."release_stage" = 'alpha' AND NEW."safety_class" <> 'doctor' AND (
    NEW."review_route" <> 'review_required' OR
    NOT EXISTS (SELECT 1 FROM "recommendation_review_events" WHERE "snapshot_id" = NEW."id" AND "event_type" = 'approved')
  ) THEN RAISE EXCEPTION 'Alpha recommendation requires explicit review'; END IF;
  IF NEW."safety_class" = 'caution' AND (
    NEW."review_route" <> 'review_required' OR
    NOT EXISTS (SELECT 1 FROM "recommendation_review_events" WHERE "snapshot_id" = NEW."id" AND "event_type" = 'approved')
  ) THEN RAISE EXCEPTION 'Caution recommendation requires review'; END IF;
  IF NEW."safety_class" = 'doctor' AND (
    NEW."review_route" <> 'fixed_fallback' OR NEW."action_code" IS NOT NULL OR
    NOT EXISTS (SELECT 1 FROM "recommendation_review_tasks" WHERE "snapshot_id" = NEW."id")
  ) THEN RAISE EXCEPTION 'Doctor recommendation requires fixed fallback and review task'; END IF;
  expected_sample_percent := (bundle_row."content_json"->>'beta_normal_review_percent')::integer;
  IF NEW."risk_area" IS NOT NULL THEN
    expected_sampling_bucket := "healthos_recommendation_sampling_bucket"(
      run_row."user_id", run_row."local_date", NEW."risk_area"
    );
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'rule:' || (NEW."provenance_json"->>'rule_key'), 0
  ));
  IF NEW."release_stage" = 'beta' AND NEW."review_route" = 'auto_publish' AND (
    NEW."safety_class" <> 'normal' OR NOT bundle_row."auto_publish_eligible"
    OR NEW."sampling_bucket" IS NULL
    OR NEW."review_sample_percent" IS DISTINCT FROM expected_sample_percent
    OR NEW."sampling_bucket" IS DISTINCT FROM expected_sampling_bucket
    OR NEW."sampling_bucket" < expected_sample_percent
    OR (
      SELECT count(DISTINCT reviewed_run."id")
      FROM "recommendation_review_events" e
      JOIN "recommendation_snapshots" reviewed_snapshot ON reviewed_snapshot."id" = e."snapshot_id"
      JOIN "recommendation_runs" reviewed_run ON reviewed_run."id" = reviewed_snapshot."run_id"
      JOIN "recommendation_review_tasks" task ON task."snapshot_id" = e."from_snapshot_id"
      JOIN "recommendation_publications" reviewed_publication
        ON reviewed_publication."snapshot_id" = reviewed_snapshot."id"
      WHERE e."event_type" = 'approved'
        AND reviewed_snapshot."review_status" = 'published'
        AND reviewed_run."rule_bundle_id" = bundle_row."id"
        AND reviewed_snapshot."provenance_json"->>'rule_key' = NEW."provenance_json"->>'rule_key'
        AND task."status" = 'completed'
        AND e."created_at" <= task."sla_at"
    ) < 100
    OR EXISTS (
      SELECT 1 FROM "safety_incidents"
      WHERE "source" = 'rule:' || (NEW."provenance_json"->>'rule_key')
    )
    OR NOT EXISTS (SELECT 1 FROM "recommendation_review_events" WHERE "snapshot_id" = NEW."id" AND "event_type" = 'auto_published')
  ) THEN RAISE EXCEPTION 'Beta auto-publish policy is not satisfied'; END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "recommendation_snapshots_publication_manifest"
AFTER INSERT ON "recommendation_snapshots"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "healthos_validate_recommendation_publication"();

CREATE FUNCTION "healthos_prevent_recommendation_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  target_user_id UUID;
BEGIN
  IF TG_OP <> 'DELETE' THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
  END IF;
  CASE TG_TABLE_NAME
    WHEN 'recommendation_snapshots' THEN
      SELECT "user_id" INTO target_user_id FROM "recommendation_runs" WHERE "id" = OLD."run_id";
    WHEN 'recommendation_review_events' THEN
      SELECT r."user_id" INTO target_user_id
      FROM "recommendation_snapshots" s JOIN "recommendation_runs" r ON r."id" = s."run_id"
      WHERE s."id" = OLD."snapshot_id";
    WHEN 'recommendation_publications' THEN
      SELECT r."user_id" INTO target_user_id
      FROM "recommendation_snapshots" s JOIN "recommendation_runs" r ON r."id" = s."run_id"
      WHERE s."id" = OLD."snapshot_id";
    WHEN 'recommendation_publication_channels' THEN
      SELECT r."user_id" INTO target_user_id
      FROM "recommendation_publications" p
      JOIN "recommendation_snapshots" s ON s."id" = p."snapshot_id"
      JOIN "recommendation_runs" r ON r."id" = s."run_id"
      WHERE p."id" = OLD."publication_id";
    WHEN 'recommendation_run_fact_inputs', 'recommendation_run_lab_inputs' THEN
      SELECT "user_id" INTO target_user_id FROM "recommendation_runs" WHERE "id" = OLD."run_id";
    WHEN 'domain_outbox_consent_requirements' THEN
      SELECT "user_id" INTO target_user_id FROM "domain_outbox" WHERE "id" = OLD."outbox_id";
    WHEN 'channel_outbox_consent_requirements' THEN
      SELECT "user_id" INTO target_user_id FROM "channel_outbox" WHERE "id" = OLD."outbox_id";
    ELSE
      RAISE EXCEPTION 'Unsupported recommendation append-only table %', TG_TABLE_NAME;
  END CASE;
  IF target_user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM "healthos_private"."privacy_delete_authorizations"
    WHERE "transaction_id" = txid_current() AND "user_id" = target_user_id
  ) THEN
    RETURN OLD;
  END IF;
  -- During an FK cascade PostgreSQL may hide the already-deleted parent run.
  -- The private authorizer is inserted and removed synchronously by the
  -- SECURITY DEFINER deletion function, so a single current-transaction row
  -- is still an exact capability for that cascade and cannot be user-forged.
  IF target_user_id IS NULL AND (
    SELECT count(*) FROM "healthos_private"."privacy_delete_authorizations"
    WHERE "transaction_id" = txid_current()
  ) = 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only outside an exact privacy-delete transaction', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER "recommendation_snapshots_append_only" ON "recommendation_snapshots";
CREATE TRIGGER "recommendation_snapshots_append_only"
BEFORE UPDATE OR DELETE ON "recommendation_snapshots"
FOR EACH ROW EXECUTE FUNCTION "healthos_prevent_recommendation_mutation"();

DROP TRIGGER "recommendation_review_events_append_only" ON "recommendation_review_events";
CREATE TRIGGER "recommendation_review_events_append_only"
BEFORE UPDATE OR DELETE ON "recommendation_review_events"
FOR EACH ROW EXECUTE FUNCTION "healthos_prevent_recommendation_mutation"();

CREATE TRIGGER "recommendation_publications_append_only"
BEFORE UPDATE OR DELETE ON "recommendation_publications"
FOR EACH ROW EXECUTE FUNCTION "healthos_prevent_recommendation_mutation"();
CREATE TRIGGER "recommendation_publication_channels_append_only"
BEFORE UPDATE OR DELETE ON "recommendation_publication_channels"
FOR EACH ROW EXECUTE FUNCTION "healthos_prevent_recommendation_mutation"();

CREATE TRIGGER "recommendation_run_fact_inputs_append_only"
BEFORE UPDATE OR DELETE ON "recommendation_run_fact_inputs"
FOR EACH ROW EXECUTE FUNCTION "healthos_prevent_recommendation_mutation"();
CREATE TRIGGER "recommendation_run_lab_inputs_append_only"
BEFORE UPDATE OR DELETE ON "recommendation_run_lab_inputs"
FOR EACH ROW EXECUTE FUNCTION "healthos_prevent_recommendation_mutation"();
CREATE TRIGGER "recommendation_domain_consent_requirements_append_only"
BEFORE UPDATE OR DELETE ON "domain_outbox_consent_requirements"
FOR EACH ROW EXECUTE FUNCTION "healthos_prevent_recommendation_mutation"();
CREATE TRIGGER "recommendation_channel_consent_requirements_append_only"
BEFORE UPDATE OR DELETE ON "channel_outbox_consent_requirements"
FOR EACH ROW EXECUTE FUNCTION "healthos_prevent_recommendation_mutation"();

CREATE FUNCTION "healthos_protect_recommendation_domain_outbox"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (
    SELECT 1 FROM "healthos_private"."privacy_delete_authorizations"
    WHERE "transaction_id" = txid_current() AND "user_id" = OLD."user_id"
  ) THEN RETURN OLD; END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Recommendation domain outbox is immutable'; END IF;
  IF (
    OLD."event_type" IS DISTINCT FROM NEW."event_type" OR
    OLD."aggregate_id" IS DISTINCT FROM NEW."aggregate_id" OR
    OLD."user_id" IS DISTINCT FROM NEW."user_id" OR
    OLD."payload" IS DISTINCT FROM NEW."payload" OR
    OLD."idempotency_key" IS DISTINCT FROM NEW."idempotency_key"
  ) THEN RAISE EXCEPTION 'Recommendation domain outbox identity is immutable'; END IF;
  RETURN NEW;
END;
$$ SECURITY DEFINER SET search_path = public, pg_temp;

CREATE FUNCTION "healthos_protect_recommendation_channel_outbox"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (
    SELECT 1 FROM "healthos_private"."privacy_delete_authorizations"
    WHERE "transaction_id" = txid_current() AND "user_id" = OLD."user_id"
  ) THEN RETURN OLD; END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Recommendation channel outbox is immutable'; END IF;
  IF (
    OLD."user_id" IS DISTINCT FROM NEW."user_id" OR
    OLD."channel" IS DISTINCT FROM NEW."channel" OR
    OLD."template" IS DISTINCT FROM NEW."template" OR
    OLD."payload" IS DISTINCT FROM NEW."payload" OR
    OLD."idempotency_key" IS DISTINCT FROM NEW."idempotency_key"
  ) THEN RAISE EXCEPTION 'Recommendation channel outbox identity is immutable'; END IF;
  RETURN NEW;
END;
$$ SECURITY DEFINER SET search_path = public, pg_temp;

CREATE TRIGGER "recommendation_domain_outbox_identity_immutable"
BEFORE UPDATE OR DELETE ON "domain_outbox"
FOR EACH ROW WHEN (OLD."event_type" IN ('recommendation.run.requested', 'recommendation.published'))
EXECUTE FUNCTION "healthos_protect_recommendation_domain_outbox"();
CREATE TRIGGER "recommendation_channel_outbox_identity_immutable"
BEFORE UPDATE OR DELETE ON "channel_outbox"
FOR EACH ROW WHEN (OLD."template" = 'recommendation_snapshot')
EXECUTE FUNCTION "healthos_protect_recommendation_channel_outbox"();

CREATE FUNCTION "healthos_protect_action_assignment_identity"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (
    SELECT 1 FROM "healthos_private"."privacy_delete_authorizations"
    WHERE "transaction_id" = txid_current() AND "user_id" = OLD."user_id"
  ) THEN RETURN OLD; END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Published action assignment identity is immutable'; END IF;
  IF OLD."user_id" IS DISTINCT FROM NEW."user_id"
    OR OLD."recommendation_snapshot_id" IS DISTINCT FROM NEW."recommendation_snapshot_id"
    OR OLD."local_date" IS DISTINCT FROM NEW."local_date"
    OR OLD."difficulty" IS DISTINCT FROM NEW."difficulty"
    OR OLD."is_primary" IS DISTINCT FROM NEW."is_primary" THEN
    RAISE EXCEPTION 'Published action assignment identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ SECURITY DEFINER SET search_path = public, pg_temp;

CREATE TRIGGER "recommendation_action_assignment_identity_immutable"
BEFORE UPDATE OR DELETE ON "action_assignments"
FOR EACH ROW EXECUTE FUNCTION "healthos_protect_action_assignment_identity"();

CREATE FUNCTION "healthos_protect_recommendation_review_task_identity"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM "healthos_private"."privacy_delete_authorizations"
      WHERE "transaction_id" = txid_current()
    ) THEN RETURN OLD; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Recommendation review task evidence is immutable'; END IF;
  IF OLD."snapshot_id" IS DISTINCT FROM NEW."snapshot_id"
    OR OLD."priority" IS DISTINCT FROM NEW."priority"
    OR OLD."sla_at" IS DISTINCT FROM NEW."sla_at"
    OR OLD."reason_code" IS DISTINCT FROM NEW."reason_code"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'Recommendation review task evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$ SECURITY DEFINER SET search_path = public, pg_temp;

CREATE TRIGGER "recommendation_review_tasks_identity_immutable"
BEFORE UPDATE OR DELETE ON "recommendation_review_tasks"
FOR EACH ROW EXECUTE FUNCTION "healthos_protect_recommendation_review_task_identity"();
