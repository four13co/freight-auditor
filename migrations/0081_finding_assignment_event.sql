-- Up Migration
-- ---------------------------------------------------------------------------
-- 0081 (86e37r2t8 Review fix): assignFinding derived its audit_event id from
-- a coarse (client_id, finding_id, event) tuple -- 'event' only has two
-- possible values ('finding.assigned'/'finding.unassigned'), so a second
-- assign after an intervening unassign hashes to the exact same id (and same
-- content) as the first assign, and writeAuditEvent's ON CONFLICT (id) DO
-- NOTHING silently drops it -- confirmed only 2 of 4 audit_event rows
-- written across an assign/unassign/assign/unassign toggle sequence.
--
-- updateFindingStatus avoids this class of bug by hashing on a fresh
-- per-transition id (finding_status_event.id, gen_random_uuid() per row)
-- instead of a coarse tuple -- this table gives assignFinding the same
-- per-transition anchor, append-only history to match.
-- ---------------------------------------------------------------------------
CREATE TABLE finding_assignment_event (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid NOT NULL REFERENCES client(id),
  variance_finding_id uuid NOT NULL REFERENCES variance_finding(id),
  assigned_to_user_id uuid REFERENCES app_user(id),
  actor_user_id       uuid REFERENCES app_user(id),
  recorded_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX finding_assignment_event_finding_idx ON finding_assignment_event (client_id, variance_finding_id, recorded_at DESC);

SELECT apply_tenant_rls('finding_assignment_event', 'client_id');

GRANT SELECT, INSERT ON finding_assignment_event TO freight_app;

-- Down Migration
REVOKE ALL ON finding_assignment_event FROM freight_app;
DROP POLICY IF EXISTS tenant_isolation ON finding_assignment_event;
DROP TABLE IF EXISTS finding_assignment_event;
