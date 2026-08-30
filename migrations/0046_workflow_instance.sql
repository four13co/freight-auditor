-- Up Migration
-- P4.A.1: workflow_instance carries only current state. State machines are
-- deliberately open per workflow_type/current_state text (not enums) --
-- concrete state graphs land with their owning phase; #169's
-- workflow_transition (append-only history) validates transitions against a
-- caller-supplied map, not a hardcoded graph here.
CREATE TABLE workflow_instance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES client(id),
  workflow_type text NOT NULL CHECK (workflow_type ~ '^[a-z][a-z0-9_]*$'),
  subject_entity text NOT NULL CHECK (subject_entity ~ '^[a-z][a-z0-9_]*$'),
  subject_entity_id uuid NOT NULL,
  current_state text NOT NULL CHECK (current_state ~ '^[a-z][a-z0-9_]*$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, workflow_type, subject_entity, subject_entity_id)
);
CREATE INDEX workflow_instance_subject_idx ON workflow_instance (client_id, subject_entity, subject_entity_id);
SELECT apply_tenant_rls('workflow_instance', 'client_id');
-- Mutable table: full CRUD, matching every other post-0010 mutable table
-- (e.g. 0016_invoice_draft.sql) -- 0010's grant loop only covers tables that
-- existed when 0010 itself ran, so every later table grants explicitly.
GRANT SELECT, INSERT, UPDATE, DELETE ON workflow_instance TO freight_app;

-- Down Migration
REVOKE ALL ON workflow_instance FROM freight_app;
DROP TABLE IF EXISTS workflow_instance;
