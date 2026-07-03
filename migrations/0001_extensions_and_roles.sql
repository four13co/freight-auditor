-- Up Migration
-- ---------------------------------------------------------------------------
-- Freight Audit Platform — canonical data model (ClickUp 86e24cy39)
-- 0001: extensions, the application role, and shared helpers.
--
-- Tenant isolation (Master Spec §1.7, §11) is STRUCTURAL: it is enforced by
-- Postgres Row-Level Security under a dedicated NON-superuser role, never by
-- app-level `WHERE client_id`. Append-only at the financial boundary (§1.5,
-- §11) is enforced by granting that same role INSERT/SELECT only on the
-- ledger tables — no UPDATE/DELETE grant exists to revoke.
--
-- NOTE (uuid v7): Master Spec §6 asks for uuid v7 PKs. Postgres 17 core ships
-- no `uuidv7()` (that lands in PG18). We default PKs to `gen_random_uuid()`
-- (v4, from pgcrypto) and will swap the default to `uuidv7()` once on PG18 —
-- the column type (uuid) does not change, so this is a default-only migration.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- GiST exclusion over (uuid, daterange)

-- The application role. The app connects as THIS role (never as the DB owner /
-- superuser), so RLS and the absence of UPDATE/DELETE grants actually bind.
-- Idempotent create so the migration is re-runnable on a fresh DB.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freight_app') THEN
    CREATE ROLE freight_app NOLOGIN;
  END IF;
END
$$;

-- Convenience: resolve the current request's client scope from the
-- transaction-scoped GUCs the app sets via SET LOCAL (Phase 0 wires the
-- runtime; the policies that read these live in 0009).
--   app.current_client_ids : comma-separated client uuids for this request
--   app.is_internal        : 'true' for internal analysts (cross-client access)
CREATE OR REPLACE FUNCTION app_current_client_ids()
RETURNS uuid[]
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    string_to_array(NULLIF(current_setting('app.current_client_ids', true), ''), ',')::uuid[],
    ARRAY[]::uuid[]
  );
$$;

CREATE OR REPLACE FUNCTION app_is_internal()
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(NULLIF(current_setting('app.is_internal', true), ''), 'false')::boolean;
$$;

-- Down Migration
DROP FUNCTION IF EXISTS app_is_internal();
DROP FUNCTION IF EXISTS app_current_client_ids();
-- role + extensions intentionally left in place on down (shared infra).
