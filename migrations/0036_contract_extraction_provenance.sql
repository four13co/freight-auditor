-- Up Migration
-- P3.B.3: provenance-bearing, append-only, retry-safe contract extraction rows.
ALTER TABLE extraction_field
  ADD COLUMN extraction_response_hash char(64),
  ADD COLUMN extraction_schema_version text,
  ADD COLUMN extraction_status text,
  ADD COLUMN citations jsonb;

ALTER TABLE extraction_field ADD CONSTRAINT extraction_field_contract_evidence_ck CHECK (
  extraction_response_hash IS NULL OR (
    extraction_response_hash ~ '^[a-f0-9]{64}$'
    AND source_document_id IS NOT NULL
    AND extraction_schema_version IS NOT NULL
    AND extraction_status IN ('FOUND', 'NOT_FOUND', 'AMBIGUOUS')
    AND confidence IS NOT NULL AND confidence BETWEEN 0 AND 1
    AND model_version IS NOT NULL AND prompt_version IS NOT NULL
    AND citations IS NOT NULL AND jsonb_typeof(citations) = 'array'
  )
);

CREATE UNIQUE INDEX extraction_field_contract_response_path_uidx
  ON extraction_field (client_id, source_document_id, extraction_response_hash, field_path)
  WHERE extraction_response_hash IS NOT NULL;

-- Down Migration
DROP INDEX IF EXISTS extraction_field_contract_response_path_uidx;
ALTER TABLE extraction_field DROP CONSTRAINT IF EXISTS extraction_field_contract_evidence_ck;
ALTER TABLE extraction_field
  DROP COLUMN IF EXISTS citations,
  DROP COLUMN IF EXISTS extraction_status,
  DROP COLUMN IF EXISTS extraction_schema_version,
  DROP COLUMN IF EXISTS extraction_response_hash;
