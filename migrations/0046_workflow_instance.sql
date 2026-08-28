-- Up Migration
-- P4.A.1: current-state record for a durable business workflow (dispute
-- lifecycle, payment approval, claim recovery -- concrete types land with
-- their owning phase, so workflow_type is an open text tag, not an enum, to
-- avoid a migration per future phase). This table carries CURRENT state
-- only and is the one place in the P4.A set where mutation is correct, since
-- it tracks an in-flight instance rather than history; the append-only
-- transition log is P4.A.2's table, not a column here. Deadlines and
-- resumable command state are P4.A.3's table, not columns here either.
--
-- Migration number 0046 (not 0045): 0045_discovery_trigger_widen.sql is
-- reserved by PR #157 (open, unmerged as of this migration).
CREATE TABLE workflow_instance (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      uuid NOT NULL REFERENCES client(id),
  workflow_type  text NOT NULL CHECK (workflow_type ~ '^[a-z][a-z0-9_]*$'),
  correlation_id text NOT NULL,
  current_state  text NOT NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, workflow_type, correlation_id)
);
CREATE INDEX workflow_instance_client_type_idx ON workflow_instance (client_id, workflow_type, current_state);

SELECT apply_tenant_rls('workflow_instance', 'client_id');

-- Unlike this repo's append-only ledgers, an instance's current_state is
-- expected to change as the workflow progresses -- grant only the two
-- mutable columns, never DELETE (an instance is retired by transitioning
-- its current_state, never removed).
GRANT SELECT, INSERT ON workflow_instance TO freight_app;
GRANT UPDATE (current_state, updated_at) ON workflow_instance TO freight_app;

-- Down Migration
REVOKE ALL ON workflow_instance FROM freight_app;
DROP TABLE IF EXISTS workflow_instance;
