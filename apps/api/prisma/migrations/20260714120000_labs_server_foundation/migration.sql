ALTER TABLE "lab_documents"
  ADD COLUMN "mime_type" TEXT NOT NULL DEFAULT 'application/pdf',
  ADD COLUMN "size_bytes" BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN "consent_epoch" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "idempotency_key" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  ADD COLUMN "request_hash" TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "failure_code" TEXT,
  ADD COLUMN "finalized_at" TIMESTAMPTZ(6),
  ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "lab_observations"
  ADD COLUMN "normalized_unit" TEXT,
  ADD COLUMN "disposition_code" TEXT NOT NULL DEFAULT 'awaiting_confirmation',
  ADD COLUMN "observation_hash" TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE "lab_observation_mutations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "observation_id" UUID NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "result_json" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lab_observation_mutations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "lab_observation_mutations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "lab_observation_mutations_observation_id_fkey" FOREIGN KEY ("observation_id") REFERENCES "lab_observations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "lab_documents_user_id_idempotency_key_key"
  ON "lab_documents"("user_id", "idempotency_key");
CREATE INDEX "lab_documents_status_updated_at_idx"
  ON "lab_documents"("status", "updated_at");
CREATE UNIQUE INDEX "lab_observation_mutations_user_id_idempotency_key_key"
  ON "lab_observation_mutations"("user_id", "idempotency_key");
CREATE INDEX "lab_observation_mutations_observation_id_created_at_idx"
  ON "lab_observation_mutations"("observation_id", "created_at");

ALTER TABLE "lab_documents"
  ADD CONSTRAINT "lab_documents_sha256_format" CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "lab_documents_request_hash_format" CHECK ("request_hash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "lab_documents_mime_allowlist" CHECK ("mime_type" IN ('application/pdf', 'image/png', 'image/jpeg')),
  ADD CONSTRAINT "lab_documents_size_bounds" CHECK ("size_bytes" BETWEEN 1 AND 20971520),
  ADD CONSTRAINT "lab_documents_version_positive" CHECK ("version" > 0),
  ADD CONSTRAINT "lab_documents_deletion_state" CHECK (("status" = 'deleted') = ("deleted_at" IS NOT NULL));

ALTER TABLE "lab_observations"
  ADD CONSTRAINT "lab_observations_page_positive" CHECK ("page" IS NULL OR "page" BETWEEN 1 AND 500),
  ADD CONSTRAINT "lab_observations_version_positive" CHECK ("version" > 0),
  ADD CONSTRAINT "lab_observations_hash_format" CHECK ("observation_hash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "lab_observations_evidence_box_shape" CHECK (
    "observation_hash" = repeat('0', 64) OR (
    jsonb_typeof("evidence_box") = 'object'
    AND "evidence_box" ?& ARRAY['x', 'y', 'width', 'height']
    AND ("evidence_box" - ARRAY['x', 'y', 'width', 'height']) = '{}'::jsonb
    AND ("evidence_box"->>'x')::numeric BETWEEN 0 AND 1
    AND ("evidence_box"->>'y')::numeric BETWEEN 0 AND 1
    AND ("evidence_box"->>'width')::numeric > 0
    AND ("evidence_box"->>'height')::numeric > 0
    AND ("evidence_box"->>'x')::numeric + ("evidence_box"->>'width')::numeric <= 1
    AND ("evidence_box"->>'y')::numeric + ("evidence_box"->>'height')::numeric <= 1)
  ),
  ADD CONSTRAINT "lab_observations_usable_allowlist" CHECK (
    "observation_hash" = repeat('0', 64) OR "confirmation_status" <> 'usable' OR (
      "code" IN ('ALT', 'AST', 'GGT', 'URIC_ACID', 'BMI', 'WEIGHT', 'WAIST')
      AND "normalized_value" IS NOT NULL
      AND "normalized_unit" IS NOT NULL
    )
  );

CREATE OR REPLACE FUNCTION "healthos_enforce_published_recommendation_inputs"()
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

  SELECT COUNT(*) INTO invalid_count
  FROM jsonb_array_elements_text(lab_ids) AS referenced(id)
  LEFT JOIN "lab_observations" observation ON observation."id"::text = referenced.id
  LEFT JOIN "lab_documents" document ON document."id" = observation."document_id"
  WHERE observation."id" IS NULL
     OR observation."confirmation_status" <> 'usable'
     OR observation."code" NOT IN ('ALT', 'AST', 'GGT', 'URIC_ACID', 'BMI', 'WEIGHT', 'WAIST')
     OR observation."normalized_value" IS NULL
     OR observation."normalized_unit" IS NULL
     OR document."status" <> 'completed'
     OR document."deleted_at" IS NOT NULL;

  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'Published recommendation references unconfirmed lab observation or deleted document'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
