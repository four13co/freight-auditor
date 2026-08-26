-- Up Migration
-- SFTP configuration contains references to secrets, never credential values.
CREATE TABLE sftp_connection (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             uuid NOT NULL REFERENCES client(id),
  name                  text NOT NULL,
  host                  text NOT NULL,
  port                  integer NOT NULL DEFAULT 22 CHECK (port BETWEEN 1 AND 65535),
  username              text NOT NULL,
  remote_path           text NOT NULL,
  private_key_secret_ref text NOT NULL,
  host_key_sha256       char(64) NOT NULL CHECK (host_key_sha256 ~ '^[0-9a-f]{64}$'),
  enabled               boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, name)
);

CREATE TABLE sftp_intake (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          uuid NOT NULL REFERENCES client(id),
  connection_id      uuid NOT NULL REFERENCES sftp_connection(id),
  remote_path        text NOT NULL,
  remote_fingerprint char(64) NOT NULL CHECK (remote_fingerprint ~ '^[0-9a-f]{64}$'),
  source_document_id uuid REFERENCES source_document(id),
  status             text NOT NULL CHECK (status IN ('discovered', 'stored', 'quarantined')),
  failure_code       text,
  discovered_at      timestamptz NOT NULL DEFAULT now(),
  stored_at          timestamptz,
  UNIQUE (connection_id, remote_path, remote_fingerprint)
);

CREATE INDEX sftp_intake_client_status_idx ON sftp_intake (client_id, status, discovered_at);
SELECT apply_tenant_rls('sftp_connection', 'client_id');
SELECT apply_tenant_rls('sftp_intake', 'client_id');
GRANT SELECT, INSERT, UPDATE, DELETE ON sftp_connection, sftp_intake TO freight_app;

-- Down Migration
DROP TABLE IF EXISTS sftp_intake;
DROP TABLE IF EXISTS sftp_connection;
