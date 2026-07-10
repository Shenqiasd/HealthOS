ALTER TABLE "devices"
ADD COLUMN "apns_token_fingerprint" TEXT,
ADD COLUMN "platform" TEXT NOT NULL DEFAULT 'ios',
ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE "apple_auth_nonces" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "nonce_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "used_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "apple_auth_nonces_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "refresh_sessions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "family_id" UUID NOT NULL,
  "token_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "rotated_at" TIMESTAMPTZ(6),
  "revoked_at" TIMESTAMPTZ(6),
  "replaced_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "refresh_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "security_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID,
  "event_type" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "metadata" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "apple_auth_nonces_nonce_hash_key" ON "apple_auth_nonces"("nonce_hash");
CREATE INDEX "apple_auth_nonces_expires_at_used_at_idx" ON "apple_auth_nonces"("expires_at", "used_at");
CREATE UNIQUE INDEX "refresh_sessions_token_hash_key" ON "refresh_sessions"("token_hash");
CREATE INDEX "refresh_sessions_user_id_revoked_at_expires_at_idx" ON "refresh_sessions"("user_id", "revoked_at", "expires_at");
CREATE INDEX "refresh_sessions_family_id_revoked_at_idx" ON "refresh_sessions"("family_id", "revoked_at");
CREATE INDEX "security_events_user_id_event_type_created_at_idx" ON "security_events"("user_id", "event_type", "created_at");
CREATE INDEX "devices_apns_token_fingerprint_idx" ON "devices"("apns_token_fingerprint");

ALTER TABLE "health_sync_runs"
ALTER COLUMN "correlation_id" TYPE TEXT USING "correlation_id"::text;

ALTER TABLE "profile_events"
ALTER COLUMN "correlation_id" TYPE TEXT USING "correlation_id"::text;

ALTER TABLE "recommendation_runs"
ALTER COLUMN "correlation_id" TYPE TEXT USING "correlation_id"::text;

ALTER TABLE "refresh_sessions"
ADD CONSTRAINT "refresh_sessions_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "refresh_sessions"
ADD CONSTRAINT "refresh_sessions_replaced_by_id_fkey"
FOREIGN KEY ("replaced_by_id") REFERENCES "refresh_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "security_events"
ADD CONSTRAINT "security_events_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TRIGGER "security_events_append_only"
BEFORE UPDATE OR DELETE ON "security_events"
FOR EACH ROW EXECUTE FUNCTION "healthos_prevent_append_only_mutation"();
