CREATE TABLE "reminder_preferences" (
  "user_id" UUID NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "intensity" TEXT NOT NULL DEFAULT 'gentle',
  "quiet_start_minute" INTEGER NOT NULL DEFAULT 1320,
  "quiet_end_minute" INTEGER NOT NULL DEFAULT 420,
  "advisor_minute" INTEGER NOT NULL DEFAULT 510,
  "behavior_minute" INTEGER NOT NULL DEFAULT 1110,
  "weekly_day" INTEGER NOT NULL DEFAULT 1,
  "weekly_minute" INTEGER NOT NULL DEFAULT 540,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reminder_preferences_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "reminder_preferences_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "reminder_preferences_version_positive" CHECK ("version" > 0),
  CONSTRAINT "reminder_preferences_intensity_allowed" CHECK ("intensity" IN ('gentle', 'standard')),
  CONSTRAINT "reminder_preferences_minutes_valid" CHECK (
    "quiet_start_minute" BETWEEN 0 AND 1439
    AND "quiet_end_minute" BETWEEN 0 AND 1439
    AND "advisor_minute" BETWEEN 0 AND 1439
    AND "behavior_minute" BETWEEN 0 AND 1439
    AND "weekly_minute" BETWEEN 0 AND 1439
    AND "quiet_start_minute" <> "quiet_end_minute"
    AND "weekly_day" BETWEEN 1 AND 7
  )
);

CREATE TABLE "reminder_preference_mutations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "idempotency_key" UUID NOT NULL,
  "request_hash" TEXT NOT NULL,
  "result_json" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reminder_preference_mutations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reminder_preference_mutations_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "reminder_preference_mutations_request_hash_sha256" CHECK ("request_hash" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "reminder_preference_mutations_user_id_idempotency_key_key"
ON "reminder_preference_mutations"("user_id", "idempotency_key");

CREATE TABLE "reminder_preference_revisions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "enabled" BOOLEAN NOT NULL,
  "intensity" TEXT NOT NULL,
  "timezone" TEXT NOT NULL,
  "quiet_start_minute" INTEGER NOT NULL,
  "quiet_end_minute" INTEGER NOT NULL,
  "advisor_minute" INTEGER NOT NULL,
  "behavior_minute" INTEGER NOT NULL,
  "weekly_day" INTEGER NOT NULL,
  "weekly_minute" INTEGER NOT NULL,
  "effective_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reminder_preference_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reminder_preference_revisions_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "reminder_preference_revisions_version_positive" CHECK ("version" > 0),
  CONSTRAINT "reminder_preference_revisions_intensity_allowed" CHECK ("intensity" IN ('gentle', 'standard')),
  CONSTRAINT "reminder_preference_revisions_minutes_valid" CHECK (
    "quiet_start_minute" BETWEEN 0 AND 1439
    AND "quiet_end_minute" BETWEEN 0 AND 1439
    AND "advisor_minute" BETWEEN 0 AND 1439
    AND "behavior_minute" BETWEEN 0 AND 1439
    AND "weekly_minute" BETWEEN 0 AND 1439
    AND "quiet_start_minute" <> "quiet_end_minute"
    AND "weekly_day" BETWEEN 1 AND 7
  )
);
CREATE UNIQUE INDEX "reminder_preference_revisions_user_id_version_key"
ON "reminder_preference_revisions"("user_id", "version");
CREATE INDEX "reminder_preference_revisions_user_id_effective_at_idx"
ON "reminder_preference_revisions"("user_id", "effective_at");

CREATE TABLE "schedule_plans" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "local_date" DATE NOT NULL,
  "period_start" DATE NOT NULL,
  "timezone" TEXT NOT NULL,
  "scheduled_at" TIMESTAMPTZ(6) NOT NULL,
  "cutoff_at" TIMESTAMPTZ(6) NOT NULL,
  "evaluated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  "requested_local_minute" INTEGER NOT NULL,
  "resolved_local_minute" INTEGER NOT NULL,
  "utc_offset_minutes" INTEGER NOT NULL,
  "preference_version" INTEGER NOT NULL,
  "notification_consent_epoch" INTEGER,
  "status" TEXT NOT NULL,
  "suppression_reason" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "schedule_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "schedule_plans_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "schedule_plans_user_id_preference_version_fkey" FOREIGN KEY ("user_id", "preference_version")
    REFERENCES "reminder_preference_revisions"("user_id", "version") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "schedule_plans_kind_allowed" CHECK ("kind" IN ('daily_advisor', 'behavior_reminder', 'weekly_review')),
  CONSTRAINT "schedule_plans_status_allowed" CHECK ("status" IN ('planned', 'suppressed')),
  CONSTRAINT "schedule_plans_version_positive" CHECK ("preference_version" > 0),
  CONSTRAINT "schedule_plans_requested_minute_valid" CHECK ("requested_local_minute" BETWEEN 0 AND 1439),
  CONSTRAINT "schedule_plans_resolved_minute_valid" CHECK ("resolved_local_minute" BETWEEN 0 AND 1439),
  CONSTRAINT "schedule_plans_offset_valid" CHECK ("utc_offset_minutes" BETWEEN -840 AND 840),
  CONSTRAINT "schedule_plans_consent_epoch_positive" CHECK (
    "notification_consent_epoch" IS NULL OR "notification_consent_epoch" > 0
  ),
  CONSTRAINT "schedule_plans_evaluated_after_schedule" CHECK ("evaluated_at" >= "scheduled_at"),
  CONSTRAINT "schedule_plans_period_not_after_local_date" CHECK ("period_start" <= "local_date"),
  CONSTRAINT "schedule_plans_status_reason_complete" CHECK (
    ("status" = 'planned' AND "suppression_reason" IS NULL AND "notification_consent_epoch" IS NOT NULL)
    OR
    ("status" = 'suppressed' AND "suppression_reason" IN (
      'disabled', 'intensity_disabled', 'notification_consent_missing',
      'missed_cutoff', 'quiet_window_exhausted', 'weekly_cadence_guard'
    ))
  )
);
CREATE UNIQUE INDEX "schedule_plans_user_id_kind_period_start_key"
ON "schedule_plans"("user_id", "kind", "period_start");
CREATE INDEX "schedule_plans_status_scheduled_at_kind_idx"
ON "schedule_plans"("status", "scheduled_at", "kind");

CREATE TABLE "scheduler_watermarks" (
  "user_id" UUID NOT NULL,
  "last_evaluated_at" TIMESTAMPTZ(6),
  "last_local_date" DATE,
  "timezone" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "scheduler_watermarks_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "scheduler_watermarks_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE FUNCTION "healthos_minute_is_quiet"(minute_value INTEGER, quiet_start INTEGER, quiet_end INTEGER)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN quiet_start < quiet_end THEN minute_value >= quiet_start AND minute_value < quiet_end
    ELSE minute_value >= quiet_start OR minute_value < quiet_end
  END
$$;

CREATE FUNCTION "healthos_validate_reminder_preference"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM "healthos_private"."privacy_delete_authorizations"
      WHERE "transaction_id" = txid_current() AND "user_id" = OLD."user_id"
    ) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Reminder preference deletion requires exact privacy authorization';
  END IF;
  IF healthos_minute_is_quiet(NEW."advisor_minute", NEW."quiet_start_minute", NEW."quiet_end_minute")
    OR healthos_minute_is_quiet(NEW."behavior_minute", NEW."quiet_start_minute", NEW."quiet_end_minute")
    OR healthos_minute_is_quiet(NEW."weekly_minute", NEW."quiet_start_minute", NEW."quiet_end_minute") THEN
    RAISE EXCEPTION 'Reminder target time cannot be inside quiet hours';
  END IF;
  IF TG_OP = 'INSERT' AND NEW."version" <> 1 THEN
    RAISE EXCEPTION 'Reminder preference must start at version one';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."user_id" <> OLD."user_id" OR NEW."created_at" <> OLD."created_at" THEN
      RAISE EXCEPTION 'Reminder preference identity is immutable';
    END IF;
    IF NEW."version" <> OLD."version" + 1 OR NEW."updated_at" <= OLD."updated_at" THEN
      RAISE EXCEPTION 'Reminder preference update must advance version and time exactly once';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "reminder_preferences_validate"
BEFORE INSERT OR UPDATE OR DELETE ON "reminder_preferences"
FOR EACH ROW EXECUTE FUNCTION "healthos_validate_reminder_preference"();

CREATE TRIGGER "reminder_preference_mutations_append_only"
BEFORE UPDATE OR DELETE ON "reminder_preference_mutations"
FOR EACH ROW EXECUTE FUNCTION "healthos_prevent_append_only_mutation"();

CREATE FUNCTION "healthos_validate_reminder_preference_revision"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_preference "reminder_preferences"%ROWTYPE;
  current_timezone TEXT;
BEGIN
  SELECT * INTO current_preference FROM "reminder_preferences" WHERE "user_id" = NEW."user_id";
  SELECT "timezone" INTO current_timezone FROM "users" WHERE "id" = NEW."user_id";
  IF current_preference."user_id" IS NULL
    OR NEW."version" <> current_preference."version"
    OR NEW."enabled" <> current_preference."enabled"
    OR NEW."intensity" <> current_preference."intensity"
    OR NEW."quiet_start_minute" <> current_preference."quiet_start_minute"
    OR NEW."quiet_end_minute" <> current_preference."quiet_end_minute"
    OR NEW."advisor_minute" <> current_preference."advisor_minute"
    OR NEW."behavior_minute" <> current_preference."behavior_minute"
    OR NEW."weekly_day" <> current_preference."weekly_day"
    OR NEW."weekly_minute" <> current_preference."weekly_minute"
    OR NEW."timezone" <> current_timezone
    OR NEW."effective_at" <> current_preference."updated_at" THEN
    RAISE EXCEPTION 'Reminder preference revision must exactly snapshot the current version';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "reminder_preference_revisions"
    WHERE "user_id" = NEW."user_id" AND "effective_at" >= NEW."effective_at"
  ) THEN
    RAISE EXCEPTION 'Reminder preference revision time must advance monotonically';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "reminder_preference_revisions_validate_insert"
BEFORE INSERT ON "reminder_preference_revisions"
FOR EACH ROW EXECUTE FUNCTION "healthos_validate_reminder_preference_revision"();
CREATE TRIGGER "reminder_preference_revisions_append_only"
BEFORE UPDATE OR DELETE ON "reminder_preference_revisions"
FOR EACH ROW EXECUTE FUNCTION "healthos_prevent_append_only_mutation"();

CREATE FUNCTION "healthos_validate_schedule_plan"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  preference "reminder_preference_revisions"%ROWTYPE;
  latest_notification "consent_records"%ROWTYPE;
  schedule_user "users"%ROWTYPE;
  local_minute INTEGER;
  local_weekday INTEGER;
  local_offset_minutes INTEGER;
  requested_local_timestamp TIMESTAMP;
  canonical_instant TIMESTAMPTZ;
  default_instant TIMESTAMPTZ;
  expected_reason TEXT;
BEGIN
  NEW."evaluated_at" := statement_timestamp();
  SELECT * INTO preference FROM "reminder_preference_revisions"
  WHERE "user_id" = NEW."user_id" AND "version" = NEW."preference_version";
  IF preference."user_id" IS NULL THEN
    RAISE EXCEPTION 'Schedule plan must bind an immutable reminder preference revision';
  END IF;
  SELECT * INTO schedule_user FROM "users" WHERE "id" = NEW."user_id";
  IF schedule_user."id" IS NULL OR schedule_user."status" <> 'active' THEN
    RAISE EXCEPTION 'Schedule plan user must be active';
  END IF;
  IF NEW."timezone" <> preference."timezone" THEN
    RAISE EXCEPTION 'Schedule plan timezone must equal its preference revision timezone';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "privacy_reconciliation" WHERE "id" = 'global' AND "status" = 'ready') THEN
    RAISE EXCEPTION 'Schedule planning requires ready privacy reconciliation';
  END IF;
  BEGIN
    IF (NEW."scheduled_at" AT TIME ZONE NEW."timezone")::date <> NEW."local_date" THEN
      RAISE EXCEPTION 'Schedule plan local date does not match timezone';
    END IF;
  EXCEPTION WHEN invalid_parameter_value THEN
    RAISE EXCEPTION 'Schedule plan timezone is invalid';
  END;
  local_minute := extract(hour FROM NEW."scheduled_at" AT TIME ZONE NEW."timezone")::integer * 60
    + extract(minute FROM NEW."scheduled_at" AT TIME ZONE NEW."timezone")::integer;
  local_weekday := extract(isodow FROM NEW."scheduled_at" AT TIME ZONE NEW."timezone")::integer;
  local_offset_minutes := (
    extract(epoch FROM (
      (NEW."scheduled_at" AT TIME ZONE NEW."timezone")
      - (NEW."scheduled_at" AT TIME ZONE 'UTC')
    )) / 60
  )::integer;
  requested_local_timestamp := NEW."local_date"::timestamp
    + make_interval(mins => NEW."requested_local_minute");
  default_instant := requested_local_timestamp AT TIME ZONE NEW."timezone";
  SELECT min(candidate) INTO canonical_instant
  FROM generate_series(
    default_instant - interval '3 hours',
    default_instant + interval '3 hours',
    interval '1 minute'
  ) AS candidate
  WHERE date_trunc('minute', candidate AT TIME ZONE NEW."timezone") = requested_local_timestamp;
  canonical_instant := coalesce(canonical_instant, default_instant);
  IF NEW."resolved_local_minute" <> local_minute THEN
    RAISE EXCEPTION 'Schedule plan resolved local minute does not match its instant';
  END IF;
  IF NEW."utc_offset_minutes" <> local_offset_minutes THEN
    RAISE EXCEPTION 'Schedule plan UTC offset does not match its timezone instant';
  END IF;
  IF healthos_minute_is_quiet(NEW."requested_local_minute", preference."quiet_start_minute", preference."quiet_end_minute") THEN
    RAISE EXCEPTION 'Schedule plan cannot fall inside quiet hours';
  END IF;
  IF NEW."scheduled_at" <> canonical_instant THEN
    RAISE EXCEPTION 'Schedule plan instant does not match the canonical IANA instant';
  END IF;
  IF NEW."scheduled_at" < preference."effective_at"
    OR EXISTS (
      SELECT 1 FROM "reminder_preference_revisions" later
      WHERE later."user_id" = NEW."user_id"
        AND later."effective_at" <= NEW."scheduled_at"
        AND later."version" > NEW."preference_version"
    ) THEN
    RAISE EXCEPTION 'Schedule plan must use the preference revision effective at its instant';
  END IF;
  IF NEW."cutoff_at" <> NEW."scheduled_at" + (CASE
    WHEN NEW."kind" = 'weekly_review' THEN interval '240 minutes'
    ELSE interval '120 minutes'
  END) THEN
    RAISE EXCEPTION 'Schedule plan cutoff does not match its canonical duration';
  END IF;
  IF NEW."kind" IN ('daily_advisor', 'behavior_reminder') AND NEW."period_start" <> NEW."local_date" THEN
    RAISE EXCEPTION 'Daily schedule period must equal its local date';
  ELSIF NEW."kind" = 'weekly_review'
    AND NEW."period_start" <> NEW."local_date" - (extract(isodow FROM NEW."local_date")::integer - 1) THEN
    RAISE EXCEPTION 'Weekly schedule period must be the ISO week Monday';
  END IF;
  IF NEW."kind" = 'daily_advisor' AND NEW."requested_local_minute" <> preference."advisor_minute" THEN
    RAISE EXCEPTION 'Advisor schedule does not match current preference';
  ELSIF NEW."kind" = 'behavior_reminder' AND NEW."requested_local_minute" <> preference."behavior_minute" THEN
    RAISE EXCEPTION 'Behavior schedule does not match current preference';
  ELSIF NEW."kind" = 'weekly_review'
    AND (NEW."requested_local_minute" <> preference."weekly_minute" OR local_weekday <> preference."weekly_day") THEN
    RAISE EXCEPTION 'Weekly schedule does not match current preference';
  END IF;
  SELECT * INTO latest_notification
  FROM "consent_records"
  WHERE "user_id" = NEW."user_id" AND "consent_type" = 'notifications'
  ORDER BY "epoch" DESC LIMIT 1;
  IF NOT preference."enabled" THEN
    expected_reason := 'disabled';
  ELSIF NEW."kind" = 'behavior_reminder' AND preference."intensity" <> 'standard' THEN
    expected_reason := 'intensity_disabled';
  ELSIF healthos_minute_is_quiet(NEW."resolved_local_minute", preference."quiet_start_minute", preference."quiet_end_minute") THEN
    expected_reason := 'quiet_window_exhausted';
  ELSIF latest_notification."id" IS NULL OR NOT latest_notification."granted" THEN
    expected_reason := 'notification_consent_missing';
  ELSIF NEW."evaluated_at" > NEW."cutoff_at" THEN
    expected_reason := 'missed_cutoff';
  ELSIF NEW."kind" = 'weekly_review' AND EXISTS (
    SELECT 1 FROM "schedule_plans"
    WHERE "user_id" = NEW."user_id"
      AND "kind" = 'weekly_review'
      AND "status" = 'planned'
      AND "local_date" >= NEW."local_date" - 6
      AND "local_date" < NEW."local_date"
  ) THEN
    expected_reason := 'weekly_cadence_guard';
  ELSE
    expected_reason := NULL;
  END IF;
  IF expected_reason IS NULL THEN
    IF NEW."status" <> 'planned'
      OR NEW."suppression_reason" IS NOT NULL
      OR NEW."notification_consent_epoch" IS DISTINCT FROM latest_notification."epoch" THEN
      RAISE EXCEPTION 'Planned reminder is not currently authorized';
    END IF;
  ELSIF NEW."status" <> 'suppressed'
    OR NEW."suppression_reason" IS DISTINCT FROM expected_reason
    OR NEW."notification_consent_epoch" IS NOT NULL THEN
    RAISE EXCEPTION 'Schedule plan suppression reason does not match canonical state';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "schedule_plans_validate_insert"
BEFORE INSERT ON "schedule_plans"
FOR EACH ROW EXECUTE FUNCTION "healthos_validate_schedule_plan"();

CREATE TRIGGER "schedule_plans_append_only"
BEFORE UPDATE OR DELETE ON "schedule_plans"
FOR EACH ROW EXECUTE FUNCTION "healthos_prevent_append_only_mutation"();

CREATE FUNCTION "healthos_validate_scheduler_watermark"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM "healthos_private"."privacy_delete_authorizations"
      WHERE "transaction_id" = txid_current() AND "user_id" = OLD."user_id"
    ) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Scheduler watermark deletion requires exact privacy authorization';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."user_id" <> OLD."user_id" OR NEW."created_at" <> OLD."created_at"
      OR (OLD."last_evaluated_at" IS NOT NULL AND NEW."last_evaluated_at" < OLD."last_evaluated_at")
      OR (OLD."last_local_date" IS NOT NULL AND NEW."last_local_date" < OLD."last_local_date")
      OR NEW."updated_at" <= OLD."updated_at" THEN
      RAISE EXCEPTION 'Scheduler watermark must advance monotonically';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "scheduler_watermarks_validate"
BEFORE UPDATE OR DELETE ON "scheduler_watermarks"
FOR EACH ROW EXECUTE FUNCTION "healthos_validate_scheduler_watermark"();
