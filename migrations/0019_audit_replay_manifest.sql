-- Up Migration
CREATE TABLE audit_replay_manifest (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL REFERENCES client(id),
  audit_run_id uuid NOT NULL REFERENCES audit_run(id),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  content_hash char(64) NOT NULL,
  manifest     jsonb NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, audit_run_id),
  UNIQUE (client_id, content_hash)
);
CREATE INDEX audit_replay_manifest_run_idx ON audit_replay_manifest (client_id, audit_run_id);

ALTER TABLE audit_replay_manifest ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_replay_manifest FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_replay_manifest
  USING (app_is_internal() OR client_id = ANY (app_current_client_ids()))
  WITH CHECK (app_is_internal() OR client_id = ANY (app_current_client_ids()));

GRANT SELECT, INSERT ON audit_replay_manifest TO freight_app;

-- Down Migration
DROP TABLE IF EXISTS audit_replay_manifest;
