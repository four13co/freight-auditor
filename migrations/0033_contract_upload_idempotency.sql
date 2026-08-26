-- Up Migration
-- One immutable source document can create at most one contract version for a
-- tenant. This is the database-level retry/concurrency guard for upload APIs.
CREATE UNIQUE INDEX contract_version_source_document_dedup_idx
  ON contract_version (client_id, source_document_id)
  WHERE source_document_id IS NOT NULL;

-- Down Migration
DROP INDEX IF EXISTS contract_version_source_document_dedup_idx;
