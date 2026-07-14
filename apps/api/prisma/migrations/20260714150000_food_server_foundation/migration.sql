ALTER TABLE "food_scans"
  ADD COLUMN "sha256" TEXT NOT NULL DEFAULT encode(digest(gen_random_uuid()::text, 'sha256'), 'hex'),
  ADD COLUMN "mime_type" TEXT NOT NULL DEFAULT 'image/jpeg',
  ADD COLUMN "size_bytes" BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN "consent_epoch" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "idempotency_key" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  ADD COLUMN "request_hash" TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
  ADD COLUMN "meal_presence" TEXT NOT NULL DEFAULT 'uncertain',
  ADD COLUMN "meal_completeness" TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN "disposition_code" TEXT NOT NULL DEFAULT 'awaiting_processing',
  ADD COLUMN "result_hash" TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "failure_code" TEXT,
  ADD COLUMN "finalized_at" TIMESTAMPTZ(6),
  ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "deleted_at" TIMESTAMPTZ(6);

ALTER TABLE "food_scans" ALTER COLUMN "model_version" SET DEFAULT 'unparsed';
ALTER TABLE "food_scans" ALTER COLUMN "overall_confidence" SET DEFAULT 0;
UPDATE "food_scans"
SET "deleted_at" = "captured_at"
WHERE "status" = 'deleted' AND "deleted_at" IS NULL;

ALTER TABLE "food_risk_labels"
  ADD COLUMN "disposition_code" TEXT NOT NULL DEFAULT 'abstained',
  ADD COLUMN "label_hash" TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
  ADD COLUMN "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE "food_dish_candidates" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "food_scan_id" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "confidence" DECIMAL(6,5) NOT NULL,
  "evidence" JSONB NOT NULL,
  "disposition_code" TEXT NOT NULL,
  "candidate_hash" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "food_dish_candidates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "food_dish_candidates_food_scan_id_fkey"
    FOREIGN KEY ("food_scan_id") REFERENCES "food_scans"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "food_correction_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "food_scan_id" UUID NOT NULL,
  "idempotency_key" UUID NOT NULL,
  "request_hash" TEXT NOT NULL,
  "expected_version" INTEGER NOT NULL,
  "meal_presence" TEXT NOT NULL,
  "meal_completeness" TEXT NOT NULL,
  "dish_codes" TEXT[] NOT NULL,
  "labels_json" JSONB NOT NULL,
  "reason_hash" TEXT NOT NULL,
  "result_json" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "food_correction_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "food_correction_events_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "food_correction_events_food_scan_id_fkey"
    FOREIGN KEY ("food_scan_id") REFERENCES "food_scans"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "food_scans_user_id_sha256_key" ON "food_scans"("user_id", "sha256");
CREATE UNIQUE INDEX "food_scans_user_id_idempotency_key_key" ON "food_scans"("user_id", "idempotency_key");
CREATE INDEX "food_scans_status_updated_at_idx" ON "food_scans"("status", "updated_at");
CREATE UNIQUE INDEX "food_dish_candidates_food_scan_id_code_key" ON "food_dish_candidates"("food_scan_id", "code");
CREATE INDEX "food_dish_candidates_food_scan_id_created_at_idx" ON "food_dish_candidates"("food_scan_id", "created_at");
CREATE INDEX "food_risk_labels_food_scan_id_created_at_idx" ON "food_risk_labels"("food_scan_id", "created_at");
CREATE UNIQUE INDEX "food_risk_labels_verified_scan_label_key"
  ON "food_risk_labels"("food_scan_id", "label")
  WHERE "label_hash" <> repeat('0', 64);
CREATE UNIQUE INDEX "food_correction_events_user_id_idempotency_key_key"
  ON "food_correction_events"("user_id", "idempotency_key");
CREATE INDEX "food_correction_events_food_scan_id_created_at_idx"
  ON "food_correction_events"("food_scan_id", "created_at");

ALTER TABLE "safety_control_revisions"
  DROP CONSTRAINT "safety_control_revisions_key_allowed",
  ADD CONSTRAINT "safety_control_revisions_key_allowed" CHECK (
    ("control_type" = 'kill_switch' AND "control_key" IN (
      'global.proactive_messages', 'channel.delivery', 'llm.generation',
      'rule.bundle', 'user.recommendations', 'review.share',
      'food.scan', 'food.label.sugary_drink', 'food.label.alcohol',
      'food.label.high_oil', 'food.label.refined_carbohydrate', 'food.label.high_purine'
    ))
    OR
    ("control_type" = 'feature_flag' AND "control_key" IN (
      'feature.daily_recommendations', 'feature.weekly_review_share', 'feature.channel_delivery'
    ))
  );

ALTER TABLE "safety_control_revisions"
  DROP CONSTRAINT "safety_control_revisions_key_scope_match",
  ADD CONSTRAINT "safety_control_revisions_key_scope_match" CHECK (
    ("control_key" IN (
      'global.proactive_messages', 'llm.generation', 'review.share',
      'feature.daily_recommendations', 'feature.weekly_review_share',
      'food.scan', 'food.label.sugary_drink', 'food.label.alcohol',
      'food.label.high_oil', 'food.label.refined_carbohydrate', 'food.label.high_purine'
    ) AND "scope_type" = 'global')
    OR ("control_key" IN ('channel.delivery', 'feature.channel_delivery') AND "scope_type" = 'channel')
    OR ("control_key" = 'rule.bundle' AND "scope_type" = 'rule_bundle')
    OR ("control_key" = 'user.recommendations' AND "scope_type" = 'user')
  );

CREATE OR REPLACE FUNCTION "healthos_food_payload_has_forbidden_key"(payload JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  item RECORD;
  element JSONB;
BEGIN
  IF payload IS NULL THEN
    RETURN FALSE;
  END IF;
  IF jsonb_typeof(payload) = 'object' THEN
    FOR item IN SELECT key, value FROM jsonb_each(payload)
    LOOP
      IF lower(item.key) ~ '(^|_)(kcal|calorie|calories|protein|proteins|carb|carbs|carbohydrate|carbohydrates|fat|fats|macro|macros|macronutrient|macronutrients|diagnosis|diagnostic|retrain|retraining)($|_)' THEN
        RETURN TRUE;
      END IF;
      IF "healthos_food_payload_has_forbidden_key"(item.value) THEN
        RETURN TRUE;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(payload) = 'array' THEN
    FOR element IN SELECT value FROM jsonb_array_elements(payload)
    LOOP
      IF "healthos_food_payload_has_forbidden_key"(element) THEN
        RETURN TRUE;
      END IF;
    END LOOP;
  END IF;
  RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION "healthos_food_evidence_valid"(evidence JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  x NUMERIC;
  y NUMERIC;
  width_value NUMERIC;
  height_value NUMERIC;
BEGIN
  IF jsonb_typeof(evidence) <> 'object'
     OR NOT evidence ?& ARRAY['x', 'y', 'width', 'height']
     OR (evidence - ARRAY['x', 'y', 'width', 'height']) <> '{}'::jsonb THEN
    RETURN FALSE;
  END IF;
  BEGIN
    x := (evidence->>'x')::numeric;
    y := (evidence->>'y')::numeric;
    width_value := (evidence->>'width')::numeric;
    height_value := (evidence->>'height')::numeric;
  EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
  END;
  RETURN x BETWEEN 0 AND 1
    AND y BETWEEN 0 AND 1
    AND width_value > 0 AND height_value > 0
    AND x + width_value <= 1
    AND y + height_value <= 1;
END;
$$;

CREATE OR REPLACE FUNCTION "healthos_food_dish_codes_valid"(codes TEXT[], presence TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  code TEXT;
  seen TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF codes IS NULL OR cardinality(codes) > 8 THEN
    RETURN FALSE;
  END IF;
  FOREACH code IN ARRAY codes
  LOOP
    IF code <> ALL(ARRAY[
      'red_braised_pork', 'white_rice', 'milk_tea', 'fried_dish',
      'ambiguous_beverage', 'mixed_meat_dish', 'beer', 'soup', 'vegetables'
    ]::TEXT[]) OR code = ANY(seen) THEN
      RETURN FALSE;
    END IF;
    seen := array_append(seen, code);
  END LOOP;
  RETURN (presence = 'food' AND cardinality(codes) > 0)
    OR (presence IN ('no_food', 'uncertain') AND cardinality(codes) = 0);
END;
$$;

CREATE OR REPLACE FUNCTION "healthos_food_correction_labels_valid"(labels JSONB, presence TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  item JSONB;
  seen TEXT[] := ARRAY[]::TEXT[];
  label_value TEXT;
BEGIN
  IF jsonb_typeof(labels) <> 'array' OR jsonb_array_length(labels) > 5 THEN
    RETURN FALSE;
  END IF;
  IF presence <> 'food' AND jsonb_array_length(labels) <> 0 THEN
    RETURN FALSE;
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(labels)
  LOOP
    IF jsonb_typeof(item) <> 'object'
       OR NOT item ?& ARRAY['label', 'level']
       OR (item - ARRAY['label', 'level']) <> '{}'::jsonb THEN
      RETURN FALSE;
    END IF;
    label_value := item->>'label';
    IF label_value <> ALL(ARRAY['sugary_drink', 'alcohol', 'high_oil', 'refined_carbohydrate', 'high_purine']::TEXT[])
       OR label_value = ANY(seen)
       OR item->>'level' <> ALL(ARRAY['unknown', 'low', 'medium', 'high']::TEXT[]) THEN
      RETURN FALSE;
    END IF;
    seen := array_append(seen, label_value);
  END LOOP;
  RETURN TRUE;
END;
$$;

ALTER TABLE "food_scans"
  ADD CONSTRAINT "food_scans_sha256_format" CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "food_scans_request_hash_format" CHECK ("request_hash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "food_scans_result_hash_format" CHECK ("result_hash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "food_scans_mime_allowlist" CHECK ("mime_type" IN ('image/png', 'image/jpeg')),
  ADD CONSTRAINT "food_scans_size_bounds" CHECK ("size_bytes" BETWEEN 1 AND 10485760),
  ADD CONSTRAINT "food_scans_version_positive" CHECK ("version" > 0),
  ADD CONSTRAINT "food_scans_meal_presence_known" CHECK ("meal_presence" IN ('food', 'no_food', 'uncertain')),
  ADD CONSTRAINT "food_scans_meal_completeness_known" CHECK ("meal_completeness" IN ('complete', 'cropped', 'unknown', 'unsupported')),
  ADD CONSTRAINT "food_scans_disposition_known" CHECK ("disposition_code" IN ('awaiting_processing', 'visible', 'needs_confirmation', 'no_food', 'unsupported', 'abstained', 'user_confirmed')),
  ADD CONSTRAINT "food_scans_deletion_state" CHECK (("status" = 'deleted') = ("deleted_at" IS NOT NULL));

ALTER TABLE "food_dish_candidates"
  ADD CONSTRAINT "food_dish_candidates_code_allowlist" CHECK ("code" IN (
    'red_braised_pork', 'white_rice', 'milk_tea', 'fried_dish',
    'ambiguous_beverage', 'mixed_meat_dish', 'beer', 'soup', 'vegetables'
  )),
  ADD CONSTRAINT "food_dish_candidates_confidence_range" CHECK ("confidence" BETWEEN 0 AND 1),
  ADD CONSTRAINT "food_dish_candidates_disposition_known" CHECK ("disposition_code" IN ('visible', 'needs_confirmation', 'abstained')),
  ADD CONSTRAINT "food_dish_candidates_hash_format" CHECK ("candidate_hash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "food_dish_candidates_evidence_shape" CHECK ("healthos_food_evidence_valid"("evidence")),
  ADD CONSTRAINT "food_dish_candidates_no_precision_fields" CHECK (NOT "healthos_food_payload_has_forbidden_key"("evidence"));

ALTER TABLE "food_risk_labels"
  ADD CONSTRAINT "food_risk_labels_allowlisted_output" CHECK (
    "label_hash" = repeat('0', 64) OR (
      "label" IN ('sugary_drink', 'alcohol', 'high_oil', 'refined_carbohydrate', 'high_purine')
      AND "level" IN ('unknown', 'low', 'medium', 'high')
      AND "disposition_code" IN ('visible', 'needs_confirmation', 'abstained')
      AND "user_correction" IS NULL
      AND "healthos_food_evidence_valid"("evidence")
      AND NOT "healthos_food_payload_has_forbidden_key"("evidence")
    )
  ),
  ADD CONSTRAINT "food_risk_labels_hash_format" CHECK ("label_hash" ~ '^[a-f0-9]{64}$');

ALTER TABLE "food_correction_events"
  ADD CONSTRAINT "food_correction_events_request_hash_format" CHECK ("request_hash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "food_correction_events_reason_hash_format" CHECK ("reason_hash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "food_correction_events_expected_version_positive" CHECK ("expected_version" > 0),
  ADD CONSTRAINT "food_correction_events_presence_known" CHECK ("meal_presence" IN ('food', 'no_food', 'uncertain')),
  ADD CONSTRAINT "food_correction_events_completeness_known" CHECK ("meal_completeness" IN ('complete', 'cropped', 'unknown')),
  ADD CONSTRAINT "food_correction_events_dishes_valid" CHECK ("healthos_food_dish_codes_valid"("dish_codes", "meal_presence")),
  ADD CONSTRAINT "food_correction_events_labels_valid" CHECK ("healthos_food_correction_labels_valid"("labels_json", "meal_presence")),
  ADD CONSTRAINT "food_correction_events_no_precision_fields" CHECK (
    NOT "healthos_food_payload_has_forbidden_key"("labels_json")
    AND NOT "healthos_food_payload_has_forbidden_key"("result_json")
  );

CREATE OR REPLACE FUNCTION "healthos_require_verified_food_label"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."label_hash" = repeat('0', 64) THEN
    RAISE EXCEPTION 'New food risk labels require a verified nonzero hash' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "food_risk_labels_verified_insert"
BEFORE INSERT ON "food_risk_labels"
FOR EACH ROW EXECUTE FUNCTION "healthos_require_verified_food_label"();

CREATE TRIGGER "food_correction_events_append_only"
BEFORE UPDATE OR DELETE ON "food_correction_events"
FOR EACH ROW EXECUTE FUNCTION "healthos_prevent_append_only_mutation"();

ALTER TABLE "food_scans" VALIDATE CONSTRAINT "food_scans_sha256_format";
ALTER TABLE "food_scans" VALIDATE CONSTRAINT "food_scans_request_hash_format";
ALTER TABLE "food_scans" VALIDATE CONSTRAINT "food_scans_result_hash_format";
ALTER TABLE "food_scans" VALIDATE CONSTRAINT "food_scans_mime_allowlist";
ALTER TABLE "food_scans" VALIDATE CONSTRAINT "food_scans_size_bounds";
ALTER TABLE "food_scans" VALIDATE CONSTRAINT "food_scans_version_positive";
ALTER TABLE "food_scans" VALIDATE CONSTRAINT "food_scans_meal_presence_known";
ALTER TABLE "food_scans" VALIDATE CONSTRAINT "food_scans_meal_completeness_known";
ALTER TABLE "food_scans" VALIDATE CONSTRAINT "food_scans_disposition_known";
ALTER TABLE "food_scans" VALIDATE CONSTRAINT "food_scans_deletion_state";
ALTER TABLE "safety_control_revisions" VALIDATE CONSTRAINT "safety_control_revisions_key_allowed";
ALTER TABLE "safety_control_revisions" VALIDATE CONSTRAINT "safety_control_revisions_key_scope_match";
ALTER TABLE "food_risk_labels" VALIDATE CONSTRAINT "food_risk_labels_allowlisted_output";
ALTER TABLE "food_risk_labels" VALIDATE CONSTRAINT "food_risk_labels_hash_format";
