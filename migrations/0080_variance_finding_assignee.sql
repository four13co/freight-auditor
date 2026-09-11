-- Up Migration
-- ---------------------------------------------------------------------------
-- 0080 (86e37r2t8): "Mine, over $500" saved view needs a self-assignment
-- concept that doesn't exist anywhere in this codebase yet -- no
-- assigned_to/similar column on variance_finding, no assignment UI. Additive
-- and nullable: every existing row starts unassigned, no backfill (there is
-- no prior "assignee" to backfill from).
--
-- Self-assign/unassign only (see this item's own Rabbit holes) -- no
-- assign-to-others workflow, so no picker/notification infra needed here,
-- just the column + a supporting index for the "mine" query shape (assignee
-- = a specific user, scoped to the tenant, same access pattern
-- variance_finding_client_status_idx (0008) already serves for `status`).
-- ---------------------------------------------------------------------------
ALTER TABLE variance_finding ADD COLUMN assigned_to_user_id uuid REFERENCES app_user(id);

CREATE INDEX variance_finding_client_assignee_idx ON variance_finding (client_id, assigned_to_user_id);

-- Down Migration
DROP INDEX IF EXISTS variance_finding_client_assignee_idx;
ALTER TABLE variance_finding DROP COLUMN IF EXISTS assigned_to_user_id;
