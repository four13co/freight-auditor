-- Up Migration
-- P3.B.9: append-only verified snapshots; uploaded versions and extraction evidence remain immutable.
CREATE TABLE verified_contract_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES client(id),
  contract_version_id uuid NOT NULL REFERENCES contract_version(id),
  source_document_id uuid NOT NULL REFERENCES source_document(id),
  extraction_response_hash char(64) NOT NULL,
  verification_hash char(64) NOT NULL,
  resolved_fields jsonb NOT NULL,
  verified_by uuid NOT NULL REFERENCES app_user(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, contract_version_id, extraction_response_hash),
  UNIQUE (client_id, verification_hash),
  CHECK (extraction_response_hash ~ '^[a-f0-9]{64}$' AND verification_hash ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(resolved_fields)='array')
);
CREATE INDEX verified_contract_version_source_idx ON verified_contract_version (client_id, source_document_id);
SELECT apply_tenant_rls('verified_contract_version', 'client_id');
GRANT SELECT, INSERT ON verified_contract_version TO freight_app;

-- Down Migration
REVOKE ALL ON verified_contract_version FROM freight_app;
DROP TABLE IF EXISTS verified_contract_version;
