-- Up Migration
-- P4.A.2: append-only transition log for a workflow_instance (P4.A.1/#160,
-- merged as migration 0046). workflow_instance's own header comment names
-- this table as this item's boundary -- current_state on workflow_instance
-- is the mutable "now", this table is the immutable "how it got there".
--
-- Rebuild of a prior version of this migration (originally #169, shipped as
-- 0049 while #160/workflow_instance was still open, with an "un-appliable
-- until #160 lands" disclosure). #160 has since merged, so workflow_instance
-- now exists and this migration applies directly -- the FK is real, not
-- aspirational. Renumbered 0049 -> 0062: 0049-0061 are all merged to
-- Development under other numbers by the time of this rebuild, so 0049
-- would collide (node-pg-migrate checkOrder) rather than apply cleanly.
CREATE TABLE workflow_transition (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id            uuid NOT NULL REFERENCES client(id),
  workflow_instance_id uuid NOT NULL REFERENCES workflow_instance(id),
  from_state           text NOT NULL,
  to_state             text NOT NULL,
  recorded_at          timestamptz NOT NULL DEFAULT now()
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
