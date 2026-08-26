-- Up Migration
ALTER TABLE rubric_snapshot DROP CONSTRAINT rubric_snapshot_tenant_id_content_hash_key;
CREATE UNIQUE INDEX rubric_snapshot_tenant_hash_unique
  ON rubric_snapshot (tenant_id, content_hash) NULLS NOT DISTINCT;

-- Down Migration
DROP INDEX IF EXISTS rubric_snapshot_tenant_hash_unique;
ALTER TABLE rubric_snapshot ADD CONSTRAINT rubric_snapshot_tenant_id_content_hash_key
  UNIQUE (tenant_id, content_hash);
