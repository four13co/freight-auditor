-- Up Migration
-- Suspicious-pass gaps are durable discovery inputs, never mutable findings.
CREATE TABLE coverage_marker (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      uuid NOT NULL REFERENCES client(id),
  audit_run_id   uuid NOT NULL REFERENCES audit_run(id) ON DELETE CASCADE,
  charge_index   integer NOT NULL CHECK (charge_index >= 0),
  marker_code    text NOT NULL,
  missing_fields text[] NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (audit_run_id, charge_index, marker_code)
);
CREATE INDEX coverage_marker_run_idx ON coverage_marker (client_id, audit_run_id);

SELECT apply_tenant_rls('coverage_marker', 'client_id');
REVOKE UPDATE, DELETE, TRUNCATE ON coverage_marker FROM freight_app;
GRANT SELECT, INSERT ON coverage_marker TO freight_app;

-- Down Migration
REVOKE ALL ON coverage_marker FROM freight_app;
DROP TABLE coverage_marker;
