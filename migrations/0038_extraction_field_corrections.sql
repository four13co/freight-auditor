-- Up Migration
-- P3.B.8: immutable correction rows keep the model value and provenance beside every human value.
ALTER TABLE extraction_field
  ADD COLUMN correction_hash char(64),
  ADD COLUMN correction_source answer_source,
  ADD COLUMN corrected_by uuid REFERENCES app_user(id);

DROP INDEX extraction_field_contract_response_path_uidx;
CREATE UNIQUE INDEX extraction_field_contract_response_path_uidx
  ON extraction_field (client_id, source_document_id, extraction_response_hash, field_path)
  WHERE extraction_response_hash IS NOT NULL AND correction_hash IS NULL;
CREATE UNIQUE INDEX extraction_field_correction_uidx
  ON extraction_field (client_id, source_document_id, extraction_response_hash, field_path, correction_hash)
  WHERE correction_hash IS NOT NULL;

ALTER TABLE extraction_field ADD CONSTRAINT extraction_field_correction_evidence_ck CHECK (
  correction_hash IS NULL OR (
    correction_hash ~ '^[a-f0-9]{64}$'
    AND human_value IS NOT NULL
    AND correction_source IS NOT NULL
    AND corrected_by IS NOT NULL
  )
);

-- Down Migration
DROP INDEX IF EXISTS extraction_field_correction_uidx;
ALTER TABLE extraction_field DROP CONSTRAINT IF EXISTS extraction_field_correction_evidence_ck;
DROP INDEX IF EXISTS extraction_field_contract_response_path_uidx;
CREATE UNIQUE INDEX extraction_field_contract_response_path_uidx
  ON extraction_field (client_id, source_document_id, extraction_response_hash, field_path)
  WHERE extraction_response_hash IS NOT NULL;
ALTER TABLE extraction_field
  DROP COLUMN IF EXISTS corrected_by,
  DROP COLUMN IF EXISTS correction_source,
  DROP COLUMN IF EXISTS correction_hash;
