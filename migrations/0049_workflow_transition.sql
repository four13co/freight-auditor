-- Up Migration
-- P4.A.2: append-only transition log for a workflow_instance (P4.A.1/#160).
-- workflow_instance's own header comment names this table as this item's
-- boundary -- current_state on workflow_instance is the mutable "now",
-- this table is the immutable "how it got there".
--
-- NOT APPLIABLE until #160 (open, unmerged as of this migration) lands:
-- workflow_instance does not exist on Development yet. This migration
-- creates ONLY workflow_transition (with a real FK to workflow_instance),
-- never a duplicate/IF-NOT-EXISTS workflow_instance -- two migrations
-- creating the same table under different numbers would silently diverge
-- or no-op depending on merge order, which is worse than a migration that
-- is honestly un-appliable until its prerequisite merges.
--
-- Migration number 0049: 0045-0048 are reserved by PRs #157/#160/#161/#163
-- (open, unmerged as of this migration).
CREATE TABLE workflow_transition (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      uuid NOT NULL REFERENCES client(id),
  workflow_instance_id uuid NOT NULL REFERENCES workflow_instance(id),
  from_state     text NOT NULL,
  to_state       text NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_transition_instance_idx ON workflow_transition (client_id, workflow_instance_id, recorded_at);

SELECT apply_tenant_rls('workflow_transition', 'client_id');

-- Append-only: INSERT + SELECT only, matching this repo's other transition
-- logs (finding_status_event, dispute_comm) rather than workflow_instance's
-- own mutable-current-state grant.
GRANT SELECT, INSERT ON workflow_transition TO freight_app;

-- Down Migration
REVOKE ALL ON workflow_transition FROM freight_app;
DROP TABLE IF EXISTS workflow_transition;
