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
-- Mutable table: full CRUD comes from 0010's default grant (not in the
-- append-only array), so no explicit GRANT is needed here.

-- Down Migration
DROP TABLE IF EXISTS workflow_instance;
