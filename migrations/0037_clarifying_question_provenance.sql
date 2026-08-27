-- Up Migration
-- P3.B.5: deterministic question identity linked to the extraction abstention.
ALTER TABLE clarifying_question
  ADD COLUMN field_path text,
  ADD COLUMN extraction_response_hash char(64),
  ADD COLUMN abstention_status text,
  ADD COLUMN abstention_reason text,
  ADD COLUMN policy_version text,
  ADD COLUMN question_hash char(64);

ALTER TABLE clarifying_question ADD CONSTRAINT clarifying_question_abstention_evidence_ck CHECK (
  extraction_response_hash IS NULL OR (
    source_document_id IS NOT NULL
    AND field_path IS NOT NULL
    AND extraction_response_hash ~ '^[a-f0-9]{64}$'
    AND abstention_status IN ('NOT_FOUND', 'AMBIGUOUS')
    AND abstention_reason IN ('MISSING_REQUIRED_FIELD', 'LOW_CONFIDENCE', 'MODEL_ABSTENTION', 'AMBIGUOUS_TABLE_ORIENTATION')
    AND policy_version IS NOT NULL
    AND question_hash ~ '^[a-f0-9]{64}$'
  )
);
CREATE UNIQUE INDEX clarifying_question_extraction_path_uidx
  ON clarifying_question (client_id, source_document_id, extraction_response_hash, field_path)
  WHERE extraction_response_hash IS NOT NULL;

-- Generated question identity is immutable. P3.B.6 may update only answer fields.
REVOKE UPDATE, DELETE ON clarifying_question FROM freight_app;
GRANT UPDATE (answer, answer_source) ON clarifying_question TO freight_app;

-- Down Migration
REVOKE UPDATE (answer, answer_source) ON clarifying_question FROM freight_app;
GRANT UPDATE, DELETE ON clarifying_question TO freight_app;
DROP INDEX IF EXISTS clarifying_question_extraction_path_uidx;
ALTER TABLE clarifying_question DROP CONSTRAINT IF EXISTS clarifying_question_abstention_evidence_ck;
ALTER TABLE clarifying_question
  DROP COLUMN IF EXISTS question_hash,
  DROP COLUMN IF EXISTS policy_version,
  DROP COLUMN IF EXISTS abstention_reason,
  DROP COLUMN IF EXISTS abstention_status,
  DROP COLUMN IF EXISTS extraction_response_hash,
  DROP COLUMN IF EXISTS field_path;
