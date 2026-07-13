CREATE TABLE "safety_control_revisions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "control_type" TEXT NOT NULL,
  "control_key" TEXT NOT NULL,
  "scope_type" TEXT NOT NULL,
  "scope_id" TEXT NOT NULL,
  "subject_user_id" UUID,
  "rule_bundle_id" UUID,
  "active" BOOLEAN NOT NULL,
  "version" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "admin_actor_id" UUID NOT NULL,
  "correlation_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "safety_control_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "safety_control_revisions_admin_actor_id_fkey" FOREIGN KEY ("admin_actor_id")
    REFERENCES "admin_actors"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "safety_control_revisions_subject_user_id_fkey" FOREIGN KEY ("subject_user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "safety_control_revisions_rule_bundle_id_fkey" FOREIGN KEY ("rule_bundle_id")
    REFERENCES "rule_bundles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "safety_control_revisions_type_allowed" CHECK ("control_type" IN ('feature_flag', 'kill_switch')),
  CONSTRAINT "safety_control_revisions_scope_allowed" CHECK ("scope_type" IN ('global', 'channel', 'rule_bundle', 'user')),
  CONSTRAINT "safety_control_revisions_version_positive" CHECK ("version" > 0),
  CONSTRAINT "safety_control_revisions_reason_allowed" CHECK ("reason" IN (
    'incident_containment', 'incident_recovery', 'staged_rollout', 'rollout_pause',
    'privacy_containment', 'safety_review', 'synthetic_test'
  )),
  CONSTRAINT "safety_control_revisions_key_allowed" CHECK (
    ("control_type" = 'kill_switch' AND "control_key" IN (
      'global.proactive_messages', 'channel.delivery', 'llm.generation',
      'rule.bundle', 'user.recommendations', 'review.share'
    ))
    OR
    ("control_type" = 'feature_flag' AND "control_key" IN (
      'feature.daily_recommendations', 'feature.weekly_review_share', 'feature.channel_delivery'
    ))
  ),
  CONSTRAINT "safety_control_revisions_scope_complete" CHECK (
    ("scope_type" = 'global' AND "scope_id" = '*' AND "subject_user_id" IS NULL AND "rule_bundle_id" IS NULL)
    OR ("scope_type" = 'channel' AND "scope_id" IN ('apns', 'wecom') AND "subject_user_id" IS NULL AND "rule_bundle_id" IS NULL)
    OR ("scope_type" = 'user' AND "scope_id" = "subject_user_id"::text AND "subject_user_id" IS NOT NULL AND "rule_bundle_id" IS NULL)
    OR ("scope_type" = 'rule_bundle' AND "scope_id" = "rule_bundle_id"::text AND "rule_bundle_id" IS NOT NULL AND "subject_user_id" IS NULL)
  ),
  CONSTRAINT "safety_control_revisions_key_scope_match" CHECK (
    ("control_key" IN ('global.proactive_messages', 'llm.generation', 'review.share', 'feature.daily_recommendations', 'feature.weekly_review_share') AND "scope_type" = 'global')
    OR ("control_key" IN ('channel.delivery', 'feature.channel_delivery') AND "scope_type" = 'channel')
    OR ("control_key" = 'rule.bundle' AND "scope_type" = 'rule_bundle')
    OR ("control_key" = 'user.recommendations' AND "scope_type" = 'user')
  )
);
CREATE UNIQUE INDEX "safety_controls_logical_version_key"
ON "safety_control_revisions"("control_type", "control_key", "scope_type", "scope_id", "version");
CREATE INDEX "safety_controls_logical_version_idx"
ON "safety_control_revisions"("control_type", "control_key", "scope_type", "scope_id", "version" DESC);
CREATE INDEX "safety_control_revisions_subject_user_id_idx" ON "safety_control_revisions"("subject_user_id");

CREATE TABLE "safety_control_mutations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "admin_actor_id" UUID NOT NULL,
  "subject_user_id" UUID,
  "idempotency_key" UUID NOT NULL,
  "request_hash" TEXT NOT NULL,
  "result_json" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "safety_control_mutations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "safety_control_mutations_admin_actor_id_fkey" FOREIGN KEY ("admin_actor_id")
    REFERENCES "admin_actors"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "safety_control_mutations_subject_user_id_fkey" FOREIGN KEY ("subject_user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "safety_control_mutations_request_hash_sha256" CHECK ("request_hash" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "safety_control_mutations_idempotency_key_key"
ON "safety_control_mutations"("idempotency_key");

CREATE TABLE "safety_control_epoch" (
  "id" TEXT NOT NULL,
  "version" BIGINT NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "safety_control_epoch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "safety_control_epoch_global_only" CHECK ("id" = 'global'),
  CONSTRAINT "safety_control_epoch_version_nonnegative" CHECK ("version" >= 0)
);
INSERT INTO "safety_control_epoch"("id", "version") VALUES ('global', 0);

CREATE TABLE "safety_control_audit_consumptions" (
  "audit_id" UUID NOT NULL,
  "control_revision_id" UUID NOT NULL,
  "operation_version" INTEGER NOT NULL,
  "operation_txid" BIGINT NOT NULL DEFAULT txid_current(),
  "consumed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "safety_control_audit_consumptions_pkey" PRIMARY KEY ("audit_id"),
  CONSTRAINT "safety_control_audit_consumptions_audit_id_fkey" FOREIGN KEY ("audit_id")
    REFERENCES "audit_logs"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "safety_control_audit_consumptions_control_revision_id_fkey" FOREIGN KEY ("control_revision_id")
    REFERENCES "safety_control_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "safety_control_audit_consumptions_version_positive" CHECK ("operation_version" > 0)
);
CREATE UNIQUE INDEX "safety_control_consumption_revision_version_key"
ON "safety_control_audit_consumptions"("control_revision_id", "operation_version");

CREATE FUNCTION "healthos_protect_safety_control_epoch"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  audit_id_text TEXT;
BEGIN
  audit_id_text := current_setting('healthos.safety_control_audit_id', true);
  IF TG_OP = 'UPDATE'
    AND NEW."id" = 'global' AND OLD."id" = 'global'
    AND NEW."version" = OLD."version" + 1
    AND NEW."updated_at" >= OLD."updated_at"
    AND audit_id_text IS NOT NULL AND audit_id_text <> ''
    AND EXISTS (
      SELECT 1
      FROM "safety_control_audit_consumptions" consumption
      JOIN "safety_control_revisions" revision
        ON revision."id" = consumption."control_revision_id"
      WHERE consumption."audit_id" = audit_id_text::uuid
        AND consumption."operation_txid" = txid_current()
        AND revision.xmin = pg_current_xact_id()::xid
    ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Safety control epoch is a protected singleton'
    USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER "safety_control_epoch_protected"
BEFORE INSERT OR UPDATE OR DELETE ON "safety_control_epoch"
FOR EACH ROW EXECUTE FUNCTION "healthos_protect_safety_control_epoch"();

ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_safety_control_complete" CHECK (
  "action" NOT LIKE 'safety_control.%' OR (
    "action" IN ('safety_control.activate', 'safety_control.deactivate')
    AND "resource_type" = 'safety_control'
    AND "admin_actor_id" IS NOT NULL
    AND "actor_role" IN ('operator', 'admin')
    AND "reason" IN (
      'incident_containment', 'incident_recovery', 'staged_rollout', 'rollout_pause',
      'privacy_containment', 'safety_review', 'synthetic_test'
    )
    AND "correlation_id" IS NOT NULL
    AND "after_json" IS NOT NULL
    AND "before_hash" IS NOT NULL AND "before_hash" ~ '^[a-f0-9]{64}$'
    AND "after_hash" IS NOT NULL AND "after_hash" ~ '^[a-f0-9]{64}$'
    AND "operation_version" IS NOT NULL AND "operation_version" > 0
  )
);

CREATE FUNCTION "healthos_safety_control_snapshot"(
  row_control_type TEXT,
  row_control_key TEXT,
  row_scope_type TEXT,
  row_scope_id TEXT,
  row_active BOOLEAN,
  row_version INTEGER,
  row_reason TEXT
)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    'control_type', row_control_type,
    'control_key', row_control_key,
    'scope_type', row_scope_type,
    'scope_ref', CASE WHEN row_scope_type = 'user'
      THEN encode(digest(row_scope_id, 'sha256'), 'hex') ELSE row_scope_id END,
    'active', row_active,
    'version', row_version,
    'reason', row_reason
  )
$$;

CREATE FUNCTION "healthos_validate_safety_control_revision"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  previous "safety_control_revisions"%ROWTYPE;
  audit_record "audit_logs"%ROWTYPE;
  audit_id_text TEXT;
  expected_before JSONB;
  expected_after JSONB;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW."control_type" || ':' || NEW."control_key" || ':' || NEW."scope_type" || ':' || NEW."scope_id", 0
  ));
  SELECT * INTO previous FROM "safety_control_revisions"
  WHERE "control_type" = NEW."control_type"
    AND "control_key" = NEW."control_key"
    AND "scope_type" = NEW."scope_type"
    AND "scope_id" = NEW."scope_id"
  ORDER BY "version" DESC LIMIT 1;
  IF NEW."version" <> coalesce(previous."version", 0) + 1 THEN
    RAISE EXCEPTION 'Safety control revision must advance exactly once';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "admin_actors" actor
    JOIN "admin_actor_roles" role ON role."actor_id" = actor."id"
    WHERE actor."id" = NEW."admin_actor_id" AND actor."status" = 'active'
      AND role."role" IN ('operator', 'admin')
  ) THEN
    RAISE EXCEPTION 'Safety control requires active operations authority';
  END IF;
  audit_id_text := current_setting('healthos.safety_control_audit_id', true);
  IF audit_id_text IS NULL OR audit_id_text = '' THEN
    RAISE EXCEPTION 'Safety control audit is required before revision';
  END IF;
  SELECT * INTO audit_record FROM "audit_logs" WHERE "id" = audit_id_text::uuid;
  expected_before := CASE WHEN previous."id" IS NULL THEN NULL ELSE healthos_safety_control_snapshot(
    previous."control_type", previous."control_key", previous."scope_type", previous."scope_id",
    previous."active", previous."version", previous."reason"
  ) END;
  expected_after := healthos_safety_control_snapshot(
    NEW."control_type", NEW."control_key", NEW."scope_type", NEW."scope_id",
    NEW."active", NEW."version", NEW."reason"
  );
  IF audit_record."id" IS NULL
    OR audit_record."admin_actor_id" <> NEW."admin_actor_id"
    OR NOT EXISTS (
      SELECT 1 FROM "admin_actor_roles" role
      WHERE role."actor_id" = NEW."admin_actor_id"
        AND role."role" = audit_record."actor_role"
        AND role."role" IN ('operator', 'admin')
    )
    OR audit_record."correlation_id" <> NEW."correlation_id"
    OR audit_record."resource_type" <> 'safety_control'
    OR audit_record."resource_id" <> NEW."id"
    OR audit_record."operation_version" <> NEW."version"
    OR audit_record."action" <> (CASE WHEN NEW."active" THEN 'safety_control.activate' ELSE 'safety_control.deactivate' END)
    OR audit_record."before_json" IS DISTINCT FROM expected_before
    OR audit_record."after_json" IS DISTINCT FROM expected_after
    OR audit_record."before_hash" <> encode(digest(coalesce(expected_before, 'null'::jsonb)::text, 'sha256'), 'hex')
    OR audit_record."after_hash" <> encode(digest(expected_after::text, 'sha256'), 'hex')
    OR audit_record."reason" <> NEW."reason"
    OR audit_record."operation_txid" <> txid_current() THEN
    RAISE EXCEPTION 'Safety control audit does not match revision';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "safety_control_revisions_validate_insert"
BEFORE INSERT ON "safety_control_revisions"
FOR EACH ROW EXECUTE FUNCTION "healthos_validate_safety_control_revision"();

CREATE FUNCTION "healthos_prevent_safety_control_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  target_user_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME = 'safety_control_audit_consumptions' THEN
      SELECT "subject_user_id" INTO target_user_id
      FROM "safety_control_revisions"
      WHERE "id" = OLD."control_revision_id";
    ELSE
      target_user_id := NULLIF(to_jsonb(OLD)->>'subject_user_id', '')::UUID;
    END IF;
    IF target_user_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM "healthos_private"."privacy_delete_authorizations"
      WHERE "transaction_id" = txid_current() AND "user_id" = target_user_id
    ) THEN
      IF TG_TABLE_NAME = 'safety_control_revisions' THEN
        DELETE FROM "safety_control_audit_consumptions"
        WHERE "control_revision_id" = OLD."id";
      END IF;
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION '% is append-only; create a new revision or event', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER "safety_control_revisions_append_only"
BEFORE UPDATE OR DELETE ON "safety_control_revisions"
FOR EACH ROW EXECUTE FUNCTION "healthos_prevent_safety_control_mutation"();
CREATE TRIGGER "safety_control_mutations_append_only"
BEFORE UPDATE OR DELETE ON "safety_control_mutations"
FOR EACH ROW EXECUTE FUNCTION "healthos_prevent_safety_control_mutation"();
CREATE TRIGGER "safety_control_audit_consumptions_append_only"
BEFORE UPDATE OR DELETE ON "safety_control_audit_consumptions"
FOR EACH ROW EXECUTE FUNCTION "healthos_prevent_safety_control_mutation"();

CREATE FUNCTION "healthos_require_safety_control_audit_consumption"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW."action" LIKE 'safety_control.%' AND NOT EXISTS (
    SELECT 1 FROM "safety_control_audit_consumptions" consumption
    JOIN "safety_control_revisions" revision ON revision."id" = consumption."control_revision_id"
    WHERE consumption."audit_id" = NEW."id"
      AND consumption."operation_txid" = txid_current()
      AND consumption."operation_version" = NEW."operation_version"
      AND revision."version" = NEW."operation_version"
      AND revision.xmin = pg_current_xact_id()::xid
      AND healthos_safety_control_snapshot(
        revision."control_type", revision."control_key", revision."scope_type", revision."scope_id",
        revision."active", revision."version", revision."reason"
      ) IS NOT DISTINCT FROM NEW."after_json"
  ) THEN
    RAISE EXCEPTION 'Safety control audit must be consumed by a same-transaction revision';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "audit_logs_safety_control_consumed"
AFTER INSERT ON "audit_logs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "healthos_require_safety_control_audit_consumption"();
