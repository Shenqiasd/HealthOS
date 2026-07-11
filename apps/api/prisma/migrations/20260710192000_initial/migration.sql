-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('active', 'deleting', 'deleted');

-- CreateEnum
CREATE TYPE "record_status" AS ENUM ('pending', 'active', 'completed', 'failed', 'suppressed', 'deleted');

-- CreateEnum
CREATE TYPE "confirmation_status" AS ENUM ('extracted', 'needs_confirmation', 'user_confirmed', 'reviewer_confirmed', 'usable', 'rejected');

-- CreateEnum
CREATE TYPE "recommendation_review_status" AS ENUM ('draft', 'safety_checked', 'review_required', 'published', 'blocked');

-- CreateEnum
CREATE TYPE "action_status" AS ENUM ('proposed', 'active', 'completed', 'skipped', 'rejected', 'replaced', 'expired');

-- CreateEnum
CREATE TYPE "channel_status" AS ENUM ('pending', 'linked', 'revoked', 'invalid');

-- CreateEnum
CREATE TYPE "outbox_status" AS ENUM ('pending', 'leased', 'sent', 'failed', 'suppressed', 'unknown_after_send');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "status" "user_status" NOT NULL DEFAULT 'active',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "locale" TEXT NOT NULL DEFAULT 'zh-CN',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_identities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_subject_hash" TEXT NOT NULL,
    "verified_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "device_id" TEXT NOT NULL,
    "apns_token_encrypted" TEXT,
    "last_seen_at" TIMESTAMPTZ(6),
    "app_version" TEXT,
    "is_primary_health_device" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "consent_type" TEXT NOT NULL,
    "document_version" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "external_id_lookup_hmac" TEXT NOT NULL,
    "external_id_encrypted" TEXT NOT NULL,
    "consent_epoch" INTEGER NOT NULL DEFAULT 1,
    "status" "channel_status" NOT NULL DEFAULT 'pending',
    "linked_at" TIMESTAMPTZ(6),

    CONSTRAINT "channel_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health_sync_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "device_id" TEXT NOT NULL,
    "anchor_epoch" INTEGER NOT NULL,
    "server_sequence" BIGINT,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "status" "record_status" NOT NULL DEFAULT 'pending',
    "correlation_id" UUID NOT NULL,

    CONSTRAINT "health_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_health_fact_revisions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "local_date" DATE NOT NULL,
    "metric" TEXT NOT NULL,
    "canonical_value_json" JSONB NOT NULL,
    "coverage" DECIMAL(6,5),
    "source_vector_json" JSONB NOT NULL,
    "input_hash" TEXT NOT NULL,
    "supersedes_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_health_fact_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "status" "record_status" NOT NULL DEFAULT 'pending',
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "lab_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_observations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "normalized_value" DECIMAL(18,6),
    "reference_range" TEXT,
    "page" INTEGER,
    "evidence_box" JSONB NOT NULL,
    "confidence" DECIMAL(6,5) NOT NULL,
    "confirmation_status" "confirmation_status" NOT NULL DEFAULT 'extracted',

    CONSTRAINT "lab_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_scans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "captured_at" TIMESTAMPTZ(6) NOT NULL,
    "model_version" TEXT NOT NULL,
    "overall_confidence" DECIMAL(6,5) NOT NULL,
    "status" "record_status" NOT NULL DEFAULT 'pending',

    CONSTRAINT "food_scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_risk_labels" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "food_scan_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "confidence" DECIMAL(6,5) NOT NULL,
    "evidence" JSONB NOT NULL,
    "user_correction" JSONB,

    CONSTRAINT "food_risk_labels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "correlation_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profile_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "facts_json" JSONB NOT NULL,
    "source_event_until" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profile_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_bundles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "published_by" TEXT,
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "rule_bundles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendation_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "local_date" DATE NOT NULL,
    "input_snapshot_id" UUID NOT NULL,
    "rule_bundle_id" UUID NOT NULL,
    "status" "record_status" NOT NULL DEFAULT 'pending',
    "correlation_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendation_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "risk_area" TEXT NOT NULL,
    "safety_class" TEXT NOT NULL,
    "action_code" TEXT NOT NULL,
    "rendered_payload_json" JSONB NOT NULL,
    "canonical_rule_input_json" JSONB NOT NULL,
    "provenance_json" JSONB NOT NULL,
    "review_status" "recommendation_review_status" NOT NULL DEFAULT 'draft',
    "supersedes_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendation_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "action_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "recommendation_snapshot_id" UUID NOT NULL,
    "local_date" DATE NOT NULL,
    "difficulty" TEXT NOT NULL,
    "status" "action_status" NOT NULL DEFAULT 'proposed',
    "is_primary" BOOLEAN NOT NULL DEFAULT true,
    "replaced_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "action_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "action_assignment_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "reason_code" TEXT,
    "text" TEXT,
    "source" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "local_date" DATE NOT NULL,
    "signal_code" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "trend" TEXT NOT NULL,
    "confidence" DECIMAL(6,5) NOT NULL,
    "drivers_json" JSONB NOT NULL,
    "provenance_json" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signal_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_review_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "week_start" DATE NOT NULL,
    "coverage" DECIMAL(6,5) NOT NULL,
    "conclusion" TEXT NOT NULL,
    "evidence_json" JSONB NOT NULL,
    "next_actions_json" JSONB NOT NULL,
    "provenance_json" JSONB NOT NULL,
    "revision" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weekly_review_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coach_threads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "status" "record_status" NOT NULL DEFAULT 'active',
    "summary" TEXT,
    "summary_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coach_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coach_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "thread_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sources_json" JSONB NOT NULL,
    "safety_class" TEXT NOT NULL,
    "model_metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coach_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_outbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "outbox_status" NOT NULL DEFAULT 'pending',

    CONSTRAINT "channel_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "outbox_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "provider_message_id" TEXT,
    "status" "outbox_status" NOT NULL,
    "error_code" TEXT,
    "sent_at" TIMESTAMPTZ(6),

    CONSTRAINT "delivery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_outbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_until" TIMESTAMPTZ(6),
    "status" "outbox_status" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consumer_inbox" (
    "consumer" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result_hash" TEXT NOT NULL,

    CONSTRAINT "consumer_inbox_pkey" PRIMARY KEY ("consumer","message_id")
);

-- CreateTable
CREATE TABLE "review_tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "task_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "priority" TEXT NOT NULL,
    "status" "record_status" NOT NULL DEFAULT 'pending',
    "assignee_id" UUID,
    "sla_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" UUID NOT NULL,
    "before_hash" TEXT,
    "after_hash" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "safety_incidents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "source" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" "record_status" NOT NULL DEFAULT 'pending',
    "details_encrypted" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "safety_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_identities_user_id_idx" ON "user_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_identities_provider_provider_subject_hash_key" ON "user_identities"("provider", "provider_subject_hash");

-- CreateIndex
CREATE INDEX "devices_user_id_idx" ON "devices"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "devices_user_id_device_id_key" ON "devices"("user_id", "device_id");

-- CreateIndex
CREATE INDEX "consent_records_user_id_consent_type_recorded_at_idx" ON "consent_records"("user_id", "consent_type", "recorded_at");

-- CreateIndex
CREATE INDEX "channel_accounts_user_id_channel_status_idx" ON "channel_accounts"("user_id", "channel", "status");

-- CreateIndex
CREATE UNIQUE INDEX "channel_accounts_tenant_id_external_id_lookup_hmac_key" ON "channel_accounts"("tenant_id", "external_id_lookup_hmac");

-- CreateIndex
CREATE INDEX "health_sync_runs_user_id_started_at_idx" ON "health_sync_runs"("user_id", "started_at");

-- CreateIndex
CREATE INDEX "daily_health_fact_revisions_user_id_local_date_metric_creat_idx" ON "daily_health_fact_revisions"("user_id", "local_date", "metric", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "daily_health_fact_revisions_user_id_local_date_metric_input_key" ON "daily_health_fact_revisions"("user_id", "local_date", "metric", "input_hash");

-- CreateIndex
CREATE INDEX "lab_documents_user_id_uploaded_at_idx" ON "lab_documents"("user_id", "uploaded_at");

-- CreateIndex
CREATE UNIQUE INDEX "lab_documents_user_id_sha256_key" ON "lab_documents"("user_id", "sha256");

-- CreateIndex
CREATE INDEX "lab_observations_document_id_code_idx" ON "lab_observations"("document_id", "code");

-- CreateIndex
CREATE INDEX "food_scans_user_id_captured_at_idx" ON "food_scans"("user_id", "captured_at");

-- CreateIndex
CREATE INDEX "food_risk_labels_food_scan_id_idx" ON "food_risk_labels"("food_scan_id");

-- CreateIndex
CREATE INDEX "profile_events_user_id_occurred_at_idx" ON "profile_events"("user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "profile_snapshots_user_id_created_at_idx" ON "profile_snapshots"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "profile_snapshots_user_id_version_key" ON "profile_snapshots"("user_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "rule_bundles_version_key" ON "rule_bundles"("version");

-- CreateIndex
CREATE UNIQUE INDEX "rule_bundles_content_hash_key" ON "rule_bundles"("content_hash");

-- CreateIndex
CREATE INDEX "recommendation_runs_user_id_local_date_idx" ON "recommendation_runs"("user_id", "local_date");

-- CreateIndex
CREATE UNIQUE INDEX "recommendation_runs_user_id_local_date_input_snapshot_id_ru_key" ON "recommendation_runs"("user_id", "local_date", "input_snapshot_id", "rule_bundle_id");

-- CreateIndex
CREATE INDEX "recommendation_snapshots_run_id_review_status_idx" ON "recommendation_snapshots"("run_id", "review_status");

-- CreateIndex
CREATE UNIQUE INDEX "recommendation_snapshots_run_id_revision_key" ON "recommendation_snapshots"("run_id", "revision");

-- CreateIndex
CREATE INDEX "action_assignments_user_id_local_date_status_idx" ON "action_assignments"("user_id", "local_date", "status");

-- CreateIndex
CREATE INDEX "feedback_events_action_assignment_id_occurred_at_idx" ON "feedback_events"("action_assignment_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "signal_snapshots_user_id_local_date_signal_code_key" ON "signal_snapshots"("user_id", "local_date", "signal_code");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_review_snapshots_user_id_week_start_revision_key" ON "weekly_review_snapshots"("user_id", "week_start", "revision");

-- CreateIndex
CREATE INDEX "coach_threads_user_id_created_at_idx" ON "coach_threads"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "coach_messages_thread_id_created_at_idx" ON "coach_messages"("thread_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "channel_outbox_idempotency_key_key" ON "channel_outbox"("idempotency_key");

-- CreateIndex
CREATE INDEX "channel_outbox_status_available_at_idx" ON "channel_outbox"("status", "available_at");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_attempts_outbox_id_attempt_key" ON "delivery_attempts"("outbox_id", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "domain_outbox_idempotency_key_key" ON "domain_outbox"("idempotency_key");

-- CreateIndex
CREATE INDEX "domain_outbox_status_available_at_lease_until_idx" ON "domain_outbox"("status", "available_at", "lease_until");

-- CreateIndex
CREATE INDEX "review_tasks_status_priority_sla_at_idx" ON "review_tasks"("status", "priority", "sla_at");

-- CreateIndex
CREATE INDEX "audit_logs_resource_type_resource_id_created_at_idx" ON "audit_logs"("resource_type", "resource_id", "created_at");

-- CreateIndex
CREATE INDEX "safety_incidents_status_severity_created_at_idx" ON "safety_incidents"("status", "severity", "created_at");

-- AddForeignKey
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_accounts" ADD CONSTRAINT "channel_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health_sync_runs" ADD CONSTRAINT "health_sync_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_health_fact_revisions" ADD CONSTRAINT "daily_health_fact_revisions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_health_fact_revisions" ADD CONSTRAINT "daily_health_fact_revisions_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "daily_health_fact_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_documents" ADD CONSTRAINT "lab_documents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_observations" ADD CONSTRAINT "lab_observations_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "lab_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_scans" ADD CONSTRAINT "food_scans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_risk_labels" ADD CONSTRAINT "food_risk_labels_food_scan_id_fkey" FOREIGN KEY ("food_scan_id") REFERENCES "food_scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_events" ADD CONSTRAINT "profile_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_snapshots" ADD CONSTRAINT "profile_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_snapshots" ADD CONSTRAINT "profile_snapshots_source_event_until_fkey" FOREIGN KEY ("source_event_until") REFERENCES "profile_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_runs" ADD CONSTRAINT "recommendation_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_runs" ADD CONSTRAINT "recommendation_runs_input_snapshot_id_fkey" FOREIGN KEY ("input_snapshot_id") REFERENCES "profile_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_runs" ADD CONSTRAINT "recommendation_runs_rule_bundle_id_fkey" FOREIGN KEY ("rule_bundle_id") REFERENCES "rule_bundles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_snapshots" ADD CONSTRAINT "recommendation_snapshots_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "recommendation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_snapshots" ADD CONSTRAINT "recommendation_snapshots_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "recommendation_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_assignments" ADD CONSTRAINT "action_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_assignments" ADD CONSTRAINT "action_assignments_recommendation_snapshot_id_fkey" FOREIGN KEY ("recommendation_snapshot_id") REFERENCES "recommendation_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_assignments" ADD CONSTRAINT "action_assignments_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "action_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_events" ADD CONSTRAINT "feedback_events_action_assignment_id_fkey" FOREIGN KEY ("action_assignment_id") REFERENCES "action_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_snapshots" ADD CONSTRAINT "signal_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_review_snapshots" ADD CONSTRAINT "weekly_review_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_threads" ADD CONSTRAINT "coach_threads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_messages" ADD CONSTRAINT "coach_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "coach_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_outbox" ADD CONSTRAINT "channel_outbox_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_outbox_id_fkey" FOREIGN KEY ("outbox_id") REFERENCES "channel_outbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "safety_incidents" ADD CONSTRAINT "safety_incidents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- HealthOS invariants that Prisma cannot express in the datamodel.
CREATE UNIQUE INDEX "devices_one_primary_health_device"
ON "devices"("user_id")
WHERE "is_primary_health_device" = true;

CREATE UNIQUE INDEX "action_assignments_one_active_primary_per_day"
ON "action_assignments"("user_id", "local_date")
WHERE "status" = 'active' AND "is_primary" = true;

ALTER TABLE "daily_health_fact_revisions"
ADD CONSTRAINT "daily_health_fact_revisions_coverage_range"
CHECK ("coverage" IS NULL OR ("coverage" >= 0 AND "coverage" <= 1));

ALTER TABLE "lab_observations"
ADD CONSTRAINT "lab_observations_confidence_range"
CHECK ("confidence" >= 0 AND "confidence" <= 1);

ALTER TABLE "food_scans"
ADD CONSTRAINT "food_scans_confidence_range"
CHECK ("overall_confidence" >= 0 AND "overall_confidence" <= 1);

ALTER TABLE "food_risk_labels"
ADD CONSTRAINT "food_risk_labels_confidence_range"
CHECK ("confidence" >= 0 AND "confidence" <= 1);

ALTER TABLE "signal_snapshots"
ADD CONSTRAINT "signal_snapshots_confidence_range"
CHECK ("confidence" >= 0 AND "confidence" <= 1);

ALTER TABLE "weekly_review_snapshots"
ADD CONSTRAINT "weekly_review_snapshots_coverage_range"
CHECK ("coverage" >= 0 AND "coverage" <= 1);

ALTER TABLE "recommendation_snapshots"
ADD CONSTRAINT "recommendation_snapshots_revision_positive"
CHECK ("revision" > 0);

CREATE VIEW "current_daily_health_facts" AS
SELECT DISTINCT ON ("user_id", "local_date", "metric")
  "id",
  "user_id",
  "local_date",
  "metric",
  "canonical_value_json",
  "coverage",
  "source_vector_json",
  "input_hash",
  "supersedes_id",
  "created_at"
FROM "daily_health_fact_revisions"
ORDER BY "user_id", "local_date", "metric", "created_at" DESC, "id" DESC;

CREATE FUNCTION "healthos_prevent_append_only_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('healthos.allow_privacy_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only; create a new revision or event', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "daily_health_fact_revisions_append_only"
BEFORE UPDATE OR DELETE ON "daily_health_fact_revisions"
FOR EACH ROW EXECUTE FUNCTION "healthos_prevent_append_only_mutation"();

CREATE TRIGGER "profile_events_append_only"
BEFORE UPDATE OR DELETE ON "profile_events"
FOR EACH ROW EXECUTE FUNCTION "healthos_prevent_append_only_mutation"();

CREATE TRIGGER "profile_snapshots_append_only"
BEFORE UPDATE OR DELETE ON "profile_snapshots"
FOR EACH ROW EXECUTE FUNCTION "healthos_prevent_append_only_mutation"();

CREATE TRIGGER "recommendation_snapshots_append_only"
BEFORE UPDATE OR DELETE ON "recommendation_snapshots"
FOR EACH ROW EXECUTE FUNCTION "healthos_prevent_append_only_mutation"();

CREATE TRIGGER "weekly_review_snapshots_append_only"
BEFORE UPDATE OR DELETE ON "weekly_review_snapshots"
FOR EACH ROW EXECUTE FUNCTION "healthos_prevent_append_only_mutation"();

CREATE TRIGGER "audit_logs_append_only"
BEFORE UPDATE OR DELETE ON "audit_logs"
FOR EACH ROW EXECUTE FUNCTION "healthos_prevent_append_only_mutation"();

CREATE FUNCTION "healthos_validate_recommendation_supersession"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  previous_run UUID;
  previous_revision INTEGER;
BEGIN
  IF NEW."supersedes_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "run_id", "revision"
  INTO previous_run, previous_revision
  FROM "recommendation_snapshots"
  WHERE "id" = NEW."supersedes_id";

  IF previous_run IS NULL
     OR previous_run <> NEW."run_id"
     OR previous_revision >= NEW."revision" THEN
    RAISE EXCEPTION 'Recommendation correction must supersede a lower revision from the same run'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "recommendation_snapshots_validate_supersession"
BEFORE INSERT ON "recommendation_snapshots"
FOR EACH ROW EXECUTE FUNCTION "healthos_validate_recommendation_supersession"();

CREATE FUNCTION "healthos_enforce_published_recommendation_inputs"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  invalid_count INTEGER;
  lab_ids JSONB;
BEGIN
  IF NEW."review_status" <> 'published' THEN
    RETURN NEW;
  END IF;

  lab_ids := COALESCE(NEW."canonical_rule_input_json" -> 'lab_observation_ids', '[]'::jsonb);
  IF jsonb_typeof(lab_ids) <> 'array' THEN
    RAISE EXCEPTION 'Published recommendation lab_observation_ids must be an array'
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*)
  INTO invalid_count
  FROM jsonb_array_elements_text(lab_ids) AS referenced(id)
  LEFT JOIN "lab_observations" observation
    ON observation."id"::text = referenced.id
  WHERE observation."id" IS NULL
     OR observation."confirmation_status" <> 'usable';

  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'Published recommendation references unconfirmed lab observation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "recommendation_snapshots_confirmed_inputs"
BEFORE INSERT ON "recommendation_snapshots"
FOR EACH ROW EXECUTE FUNCTION "healthos_enforce_published_recommendation_inputs"();
