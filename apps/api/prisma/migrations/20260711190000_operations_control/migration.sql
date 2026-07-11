CREATE TABLE "admin_actors" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "lookup_hash" TEXT NOT NULL,
  "display_label" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_actors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_actors_lookup_hash_sha256" CHECK ("lookup_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "admin_actors_status_allowed" CHECK ("status" IN ('active', 'disabled')),
  CONSTRAINT "admin_actors_display_label_present" CHECK (length(btrim("display_label")) BETWEEN 1 AND 120)
);

CREATE UNIQUE INDEX "admin_actors_lookup_hash_key" ON "admin_actors"("lookup_hash");
CREATE INDEX "admin_actors_status_id_idx" ON "admin_actors"("status", "id");

CREATE TABLE "admin_actor_roles" (
  "actor_id" UUID NOT NULL,
  "role" TEXT NOT NULL,
  CONSTRAINT "admin_actor_roles_pkey" PRIMARY KEY ("actor_id", "role"),
  CONSTRAINT "admin_actor_roles_role_allowed" CHECK (
    "role" IN ('reviewer', 'operator', 'admin', 'medical_approver')
  ),
  CONSTRAINT "admin_actor_roles_actor_id_fkey" FOREIGN KEY ("actor_id")
    REFERENCES "admin_actors"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "admin_actor_subject_scopes" (
  "actor_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  CONSTRAINT "admin_actor_subject_scopes_pkey" PRIMARY KEY ("actor_id", "user_id"),
  CONSTRAINT "admin_actor_subject_scopes_actor_id_fkey" FOREIGN KEY ("actor_id")
    REFERENCES "admin_actors"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "admin_actor_subject_scopes_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "admin_actor_subject_scopes_user_id_actor_id_idx"
ON "admin_actor_subject_scopes"("user_id", "actor_id");

ALTER TABLE "review_tasks"
ADD COLUMN "user_id" UUID,
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD CONSTRAINT "review_tasks_user_id_fkey" FOREIGN KEY ("user_id")
  REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "review_tasks_version_positive" CHECK ("version" > 0),
ADD CONSTRAINT "review_tasks_operations_priority_allowed" CHECK (
  "user_id" IS NULL OR "priority" IN ('low', 'normal', 'high', 'urgent')
),
ADD CONSTRAINT "review_tasks_operations_type_allowed" CHECK (
  "user_id" IS NULL OR "task_type" IN ('recommendation_triage', 'lab_evidence', 'feedback_attention', 'safety_incident')
);
CREATE INDEX "review_tasks_user_id_status_sla_at_id_idx"
ON "review_tasks"("user_id", "status", "sla_at", "id");
CREATE INDEX "review_tasks_assignee_id_status_sla_at_id_idx"
ON "review_tasks"("assignee_id", "status", "sla_at", "id");

CREATE TABLE "admin_queue_snapshots" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "actor_id" UUID NOT NULL,
  "queue_kind" TEXT NOT NULL,
  "status_filter" TEXT NOT NULL,
  "filter_hash" TEXT NOT NULL,
  "authorization_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_queue_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_queue_snapshots_actor_id_fkey" FOREIGN KEY ("actor_id")
    REFERENCES "admin_actors"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "admin_queue_snapshots_kind_allowed" CHECK ("queue_kind" IN ('review', 'safety')),
  CONSTRAINT "admin_queue_snapshots_status_allowed" CHECK ("status_filter" IN ('open', 'pending', 'active', 'completed')),
  CONSTRAINT "admin_queue_snapshots_filter_hash_sha256" CHECK ("filter_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "admin_queue_snapshots_authorization_hash_sha256" CHECK ("authorization_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "admin_queue_snapshots_expiry_after_creation" CHECK ("expires_at" > "created_at")
);
CREATE INDEX "admin_queue_snapshots_actor_id_expires_at_idx"
ON "admin_queue_snapshots"("actor_id", "expires_at");

CREATE TABLE "admin_queue_snapshot_items" (
  "snapshot_id" UUID NOT NULL,
  "position" INTEGER NOT NULL,
  "work_item_id" UUID NOT NULL,
  "work_item_version" INTEGER NOT NULL,
  CONSTRAINT "admin_queue_snapshot_items_pkey" PRIMARY KEY ("snapshot_id", "position"),
  CONSTRAINT "admin_queue_snapshot_items_snapshot_id_work_item_id_key" UNIQUE ("snapshot_id", "work_item_id"),
  CONSTRAINT "admin_queue_snapshot_items_position_nonnegative" CHECK ("position" >= 0),
  CONSTRAINT "admin_queue_snapshot_items_version_positive" CHECK ("work_item_version" > 0),
  CONSTRAINT "admin_queue_snapshot_items_snapshot_id_fkey" FOREIGN KEY ("snapshot_id")
    REFERENCES "admin_queue_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "admin_queue_snapshot_items_work_item_id_fkey" FOREIGN KEY ("work_item_id")
    REFERENCES "review_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "admin_queue_snapshot_items_work_item_id_idx"
ON "admin_queue_snapshot_items"("work_item_id");

ALTER TABLE "audit_logs"
ADD COLUMN "admin_actor_id" UUID,
ADD COLUMN "actor_role" TEXT,
ADD COLUMN "reason" TEXT,
ADD COLUMN "correlation_id" UUID,
ADD COLUMN "before_json" JSONB,
ADD COLUMN "after_json" JSONB,
ADD COLUMN "operation_version" INTEGER,
ADD COLUMN "operation_txid" BIGINT NOT NULL DEFAULT txid_current(),
ADD CONSTRAINT "audit_logs_admin_actor_id_fkey" FOREIGN KEY ("admin_actor_id")
  REFERENCES "admin_actors"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "audit_logs_operation_version_positive" CHECK (
  "operation_version" IS NULL OR "operation_version" > 0
),
ADD CONSTRAINT "audit_logs_operations_complete" CHECK (
  "action" NOT LIKE 'operations.%' OR (
    "action" IN (
      'operations.review_task.claim',
      'operations.review_task.reassign',
      'operations.review_task.release',
      'operations.safety_incident.acknowledge',
      'operations.safety_incident.resolve',
      'operations.safety_incident.reopen'
    )
    AND
    "admin_actor_id" IS NOT NULL
    AND "actor_role" IN ('reviewer', 'operator', 'admin', 'medical_approver')
    AND "reason" IS NOT NULL
    AND length(btrim("reason")) BETWEEN 3 AND 500
    AND "correlation_id" IS NOT NULL
    AND "before_json" IS NOT NULL
    AND "after_json" IS NOT NULL
    AND "before_hash" IS NOT NULL
    AND "after_hash" IS NOT NULL
    AND "before_hash" ~ '^[a-f0-9]{64}$'
    AND "after_hash" ~ '^[a-f0-9]{64}$'
    AND "operation_version" IS NOT NULL
  )
);
CREATE INDEX "audit_logs_admin_actor_id_created_at_idx"
ON "audit_logs"("admin_actor_id", "created_at");

CREATE TABLE "operation_audit_consumptions" (
  "audit_id" UUID NOT NULL,
  "work_item_id" UUID NOT NULL,
  "operation_version" INTEGER NOT NULL,
  "operation_txid" BIGINT NOT NULL DEFAULT txid_current(),
  "consumed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "operation_audit_consumptions_pkey" PRIMARY KEY ("audit_id"),
  CONSTRAINT "operation_audit_consumptions_audit_id_fkey" FOREIGN KEY ("audit_id")
    REFERENCES "audit_logs"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "operation_audit_consumptions_version_positive" CHECK ("operation_version" > 0)
);
CREATE UNIQUE INDEX "operation_audit_consumptions_work_item_id_operation_version_key"
ON "operation_audit_consumptions"("work_item_id", "operation_version");
CREATE TRIGGER "operation_audit_consumptions_append_only"
BEFORE UPDATE OR DELETE ON "operation_audit_consumptions"
FOR EACH ROW EXECUTE FUNCTION "healthos_prevent_append_only_mutation"();

CREATE FUNCTION "healthos_require_operations_audit_consumption"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW."action" LIKE 'operations.%' AND NOT EXISTS (
    SELECT 1
    FROM "operation_audit_consumptions" consumption
    JOIN "review_tasks" work_item ON work_item."id" = consumption."work_item_id"
    WHERE consumption."audit_id" = NEW."id"
      AND consumption."operation_txid" = txid_current()
      AND consumption."operation_version" = NEW."operation_version"
      AND work_item."version" = NEW."operation_version"
      AND work_item.xmin = pg_current_xact_id()::xid
      AND healthos_operations_audit_snapshot(
        work_item."status", work_item."assignee_id", work_item."version"
      ) IS NOT DISTINCT FROM NEW."after_json"
      AND (
        (
          NEW."action" LIKE 'operations.review_task.%'
          AND NEW."resource_type" = 'review_task'
          AND work_item."task_type" <> 'safety_incident'
          AND work_item."id" = NEW."resource_id"
        )
        OR (
          NEW."action" LIKE 'operations.safety_incident.%'
          AND NEW."resource_type" = 'safety_incident'
          AND work_item."task_type" = 'safety_incident'
          AND work_item."subject_id" = NEW."resource_id"
        )
      )
  ) THEN
    RAISE EXCEPTION 'Operations audit must be consumed by a same-transaction mutation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "audit_logs_operations_consumed"
AFTER INSERT ON "audit_logs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "healthos_require_operations_audit_consumption"();

CREATE FUNCTION "healthos_operations_audit_snapshot"(
  row_status "record_status",
  row_assignee UUID,
  row_version INTEGER
)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    'status', row_status::text,
    'assignee_id', row_assignee,
    'version', row_version
  )
$$;

CREATE FUNCTION "healthos_validate_operations_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  audit_id_text TEXT;
  audit_record "audit_logs"%ROWTYPE;
  expected_before JSONB;
  expected_after JSONB;
  expected_resource_type TEXT;
  expected_action_prefix TEXT;
  actor_is_global BOOLEAN;
  actor_has_scope BOOLEAN;
  target_is_eligible BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'review_tasks' THEN
    IF NEW."id" <> OLD."id"
      OR NEW."task_type" <> OLD."task_type"
      OR NEW."subject_id" <> OLD."subject_id"
      OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
      OR NEW."priority" <> OLD."priority"
      OR NEW."sla_at" <> OLD."sla_at"
      OR NEW."created_at" <> OLD."created_at" THEN
      RAISE EXCEPTION 'Operations review task immutable fields cannot change';
    END IF;
    IF NEW."task_type" = 'safety_incident' THEN
      expected_resource_type := 'safety_incident';
      expected_action_prefix := 'operations.safety_incident.';
    ELSE
      expected_resource_type := 'review_task';
      expected_action_prefix := 'operations.review_task.';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported operations mutation table';
  END IF;

  IF NEW."version" <> OLD."version" + 1 OR NEW."updated_at" <= OLD."updated_at" THEN
    RAISE EXCEPTION 'Operations mutation must advance version and update time exactly once';
  END IF;

  audit_id_text := current_setting('healthos.operations_audit_id', true);
  IF audit_id_text IS NULL OR audit_id_text = '' THEN
    RAISE EXCEPTION 'Operations audit is required before state mutation';
  END IF;
  SELECT * INTO audit_record FROM "audit_logs" WHERE "id" = audit_id_text::uuid;
  IF audit_record."id" IS NULL THEN
    RAISE EXCEPTION 'Operations audit record does not exist';
  END IF;
  IF audit_record."operation_txid" IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'Operations audit must be created in the mutation transaction';
  END IF;

  expected_before := healthos_operations_audit_snapshot(OLD."status", OLD."assignee_id", OLD."version");
  expected_after := healthos_operations_audit_snapshot(NEW."status", NEW."assignee_id", NEW."version");
  actor_is_global := audit_record."actor_role" IN ('operator', 'admin');
  SELECT NEW."user_id" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "admin_actor_subject_scopes"
    WHERE "actor_id" = audit_record."admin_actor_id" AND "user_id" = NEW."user_id"
  ) INTO actor_has_scope;

  IF audit_record."action" = 'operations.review_task.claim' THEN
    IF NEW."task_type" = 'safety_incident'
      OR OLD."status" <> 'pending' OR OLD."assignee_id" IS NOT NULL
      OR NEW."status" <> 'active' OR NEW."assignee_id" IS DISTINCT FROM audit_record."admin_actor_id"
      OR audit_record."actor_role" NOT IN ('reviewer', 'medical_approver', 'operator', 'admin')
      OR NOT (actor_is_global OR actor_has_scope) THEN
      RAISE EXCEPTION 'Operations review claim transition is not authorized';
    END IF;
  ELSIF audit_record."action" = 'operations.review_task.release' THEN
    IF NEW."task_type" = 'safety_incident'
      OR OLD."status" <> 'active' OR OLD."assignee_id" IS NULL
      OR NEW."status" <> 'pending' OR NEW."assignee_id" IS NOT NULL
      OR audit_record."actor_role" NOT IN ('reviewer', 'medical_approver', 'operator', 'admin')
      OR NOT (actor_is_global OR (actor_has_scope AND audit_record."admin_actor_id" = OLD."assignee_id")) THEN
      RAISE EXCEPTION 'Operations review release transition is not authorized';
    END IF;
  ELSIF audit_record."action" = 'operations.review_task.reassign' THEN
    SELECT EXISTS (
      SELECT 1
      FROM "admin_actors" target
      JOIN "admin_actor_roles" role ON role."actor_id" = target."id"
      WHERE target."id" = NEW."assignee_id" AND target."status" = 'active'
        AND role."role" IN ('reviewer', 'medical_approver', 'operator', 'admin')
        AND (
          role."role" IN ('operator', 'admin')
          OR EXISTS (
            SELECT 1 FROM "admin_actor_subject_scopes" scope
            WHERE scope."actor_id" = target."id" AND scope."user_id" = NEW."user_id"
          )
        )
    ) INTO target_is_eligible;
    IF NEW."task_type" = 'safety_incident'
      OR OLD."status" <> 'active' OR OLD."assignee_id" IS NULL
      OR NEW."status" <> 'active' OR NEW."assignee_id" IS NULL
      OR NEW."assignee_id" = OLD."assignee_id"
      OR audit_record."actor_role" NOT IN ('operator', 'admin')
      OR NOT actor_is_global OR NOT target_is_eligible THEN
      RAISE EXCEPTION 'Operations review reassignment is not authorized';
    END IF;
  ELSIF audit_record."action" = 'operations.safety_incident.acknowledge' THEN
    IF NEW."task_type" <> 'safety_incident'
      OR OLD."status" <> 'pending' OR NEW."status" <> 'active'
      OR NEW."assignee_id" IS DISTINCT FROM audit_record."admin_actor_id"
      OR audit_record."actor_role" NOT IN ('operator', 'admin') OR NOT actor_is_global THEN
      RAISE EXCEPTION 'Operations safety acknowledgement is not authorized';
    END IF;
  ELSIF audit_record."action" = 'operations.safety_incident.resolve' THEN
    IF NEW."task_type" <> 'safety_incident'
      OR OLD."status" <> 'active' OR NEW."status" <> 'completed'
      OR NEW."assignee_id" IS DISTINCT FROM OLD."assignee_id"
      OR audit_record."actor_role" NOT IN ('operator', 'admin') OR NOT actor_is_global THEN
      RAISE EXCEPTION 'Operations safety resolution is not authorized';
    END IF;
  ELSIF audit_record."action" = 'operations.safety_incident.reopen' THEN
    IF NEW."task_type" <> 'safety_incident'
      OR OLD."status" <> 'completed' OR NEW."status" <> 'active'
      OR NEW."assignee_id" IS DISTINCT FROM audit_record."admin_actor_id"
      OR audit_record."actor_role" NOT IN ('operator', 'admin') OR NOT actor_is_global THEN
      RAISE EXCEPTION 'Operations safety reopen is not authorized';
    END IF;
  END IF;

  IF audit_record."resource_type" IS DISTINCT FROM expected_resource_type
    OR audit_record."resource_id" IS DISTINCT FROM (CASE WHEN NEW."task_type" = 'safety_incident' THEN NEW."subject_id" ELSE NEW."id" END)
    OR audit_record."action" NOT LIKE expected_action_prefix || '%'
    OR audit_record."operation_version" IS DISTINCT FROM NEW."version"
    OR audit_record."before_json" IS DISTINCT FROM expected_before
    OR audit_record."after_json" IS DISTINCT FROM expected_after
    OR audit_record."before_hash" IS DISTINCT FROM encode(digest(expected_before::text, 'sha256'), 'hex')
    OR audit_record."after_hash" IS DISTINCT FROM encode(digest(expected_after::text, 'sha256'), 'hex')
    OR NOT EXISTS (
      SELECT 1
      FROM "admin_actors" actor
      JOIN "admin_actor_roles" role ON role."actor_id" = actor."id"
      WHERE actor."id" = audit_record."admin_actor_id"
        AND actor."status" = 'active'
        AND role."role" = audit_record."actor_role"
    ) THEN
    RAISE EXCEPTION 'Operations audit does not match the requested state mutation';
  END IF;
  INSERT INTO "operation_audit_consumptions"(
    "audit_id", "work_item_id", "operation_version", "operation_txid"
  ) VALUES (
    audit_record."id", NEW."id", NEW."version", txid_current()
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER "review_tasks_operations_audit"
BEFORE UPDATE ON "review_tasks"
FOR EACH ROW EXECUTE FUNCTION "healthos_validate_operations_mutation"();
