-- Up Migration
-- ---------------------------------------------------------------------------
-- 0070: add 'client' to the actor_kind enum (P6.A.4, 86e2zfjp9).
--
-- actor_kind is 'analyst', 'ai', 'system' -- none of which honestly describes
-- a client-portal user (client_admin/client_viewer membership role) taking an
-- auditable action through the portal. Recording a portal-driven membership
-- role change as actor_kind 'analyst' would be a silent lie about who
-- actually performed it (this repo's own §10 rule: honest-missing beats
-- guessed -- and a wrong value is worse than a missing one for an
-- evidentiary record). Postgres enums only support additive
-- ALTER TYPE ... ADD VALUE, matching this repo's established additive-schema
-- convention (0017/0052 precedent).
-- ---------------------------------------------------------------------------

ALTER TYPE actor_kind ADD VALUE 'client';

-- Down Migration
-- Postgres has no DROP VALUE for enums; a real rollback would require
-- rebuilding the type (rename old, create new, cast every column, drop old)
-- across every audit_event/finding_status_event/dispute_comm/... consumer --
-- destructive and out of scope for a down migration this repo has never
-- needed for an enum-value addition before (0017/0052 precedent). Left as a
-- documented no-op, consistent with the irreversibility Postgres itself
-- imposes here.
