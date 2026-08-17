-- Up Migration
-- ---------------------------------------------------------------------------
-- 0013: grant freight_app to the connecting role (86e2v1qxz).
--
-- 0001 created `freight_app` NOLOGIN but never granted it to anything, so
-- `SET LOCAL ROLE freight_app` (src/db/tenant-context.ts's setTenantTxScope --
-- the call that drops BYPASSRLS and makes RLS actually enforce) only worked
-- when the connecting role happened to be a superuser/owner, which can assume
-- any role regardless of grants. Dev/CI connect as the container's owner, so
-- this was invisible there; Neon connects as a non-owner role, which raises
-- 42501 "permission denied to set role" on every tenant-scoped query.
--
-- Granting to CURRENT_USER (the role actually running this migration, i.e.
-- whatever DATABASE_URL authenticates as in each environment) rather than a
-- hardcoded username -- dev, CI, and prod all connect as different roles, and
-- this migration runs once per environment as exactly the role that needs it.
--
-- No DO $$ ... EXCEPTION WHEN insufficient_privilege $$ wrapper: a swallowed
-- failure here is the "migration that silently no-ops" this item explicitly
-- warns against. If the connecting role lacks ADMIN OPTION on freight_app,
-- this must fail loudly and block the migrate-database job.
-- ---------------------------------------------------------------------------

GRANT freight_app TO CURRENT_USER;

-- Down Migration
REVOKE freight_app FROM CURRENT_USER;
