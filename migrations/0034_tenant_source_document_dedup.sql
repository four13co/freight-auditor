-- Up Migration
-- Content blobs remain globally content-addressed in R2, while metadata rows
-- are tenant-owned. Identical bytes in two tenants must produce two RLS-safe
-- references instead of leaking/reusing the first tenant's row.
ALTER TABLE source_document DROP CONSTRAINT source_document_sha256_key;
CREATE UNIQUE INDEX source_document_tenant_sha256_idx
  ON source_document (client_id, sha256) NULLS NOT DISTINCT;

-- Down Migration
DROP INDEX IF EXISTS source_document_tenant_sha256_idx;
ALTER TABLE source_document ADD CONSTRAINT source_document_sha256_key UNIQUE (sha256);
