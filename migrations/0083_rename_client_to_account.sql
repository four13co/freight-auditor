-- Up Migration
-- ---------------------------------------------------------------------------
-- 0083 (86e3ankd7): physical DB rename of the tenant-root concept from
-- "client" to "account" -- the frontend-facing rename already landed in
-- #415/#416 (86e3anfun/86e3anfux); this is the backend/DB layer those items
-- explicitly excluded. One-off, human-authorized exception to the build
-- loop's additive-only-schema invariant (Greg, via Bridge, comment on
-- 86e3ankd7: "system hasn't launched -- no live users, no production data
-- at risk"). Big-bang rename, no dual-write/expand-contract shim, per this
-- task's own No-gos.
--
-- Renamed:
--   * the `client` and `client_payment_policy` tables -> `account` /
--     `account_payment_policy`
--   * every `client_id` column (67 tables, confirmed via information_schema)
--     -> `account_id`, plus `rubric.scope_client_id` -> `scope_account_id`
--   * every index/constraint with "client" in its name -> "account"
--     (dynamic: computed from the live catalog below, not a hand-typed
--     list, so nothing is missed and nothing silently drifts from this
--     migration's own logic; the handful of auto-generated UNIQUE
--     constraint names that would exceed Postgres's 63-byte NAMEDATALEN
--     limit under a naive string substitution are dropped and re-added
--     unnamed instead, so Postgres regenerates its own correctly-truncated
--     name under the new column list, rather than risking a mis-truncated
--     or colliding name from manual string math)
--   * membership_role enum values client_viewer/client_admin ->
--     account_viewer/account_admin
--   * app_current_client_ids() -> app_current_account_ids() (name AND body,
--     which now reads the app.current_account_ids GUC); apply_tenant_rls()'s
--     generated policy SQL updated to call the renamed function.
--     app_is_internal() is untouched -- already neutral, not "client"-named.
--
-- NOT renamed (confirmed empirically before writing this migration, see
-- this PR's Uncertainties for the full verification):
--   * `rubric_snapshot.tenant_id` / `resolution_conflict.tenant_id` --
--     already say "tenant", not "client"; task's own Rabbit holes flagged
--     these as possibly-already-neutral, and there's no evidence a
--     "tenant"->"account" rename was ever separately requested.
--   * The ~34 RLS policies themselves (their USING/WITH CHECK expressions
--     re-resolve column and function references by OID, not by stored
--     text -- confirmed empirically: renaming a column or a function that
--     an existing policy references automatically updates what
--     pg_get_expr()/psql \d show for that policy, with no DROP/CREATE
--     POLICY needed).
--   * `charge_alignment_member`'s "landmine" policy the task's Problem
--     section describes (current_setting('app.client_id', true) -- a GUC
--     nothing ever sets) is STALE: migration 0071 already replaced it with
--     the standard apply_tenant_rls()-generated policy, before this task
--     was written. Verified live: `\d charge_alignment_member` on a fresh
--     migrate-up shows policy "tenant_isolation" using
--     app_current_client_ids(), identical to every other tenant table --
--     no landmine remains to preserve-or-flag; this migration renames its
--     client_id column exactly like every other table's, and the policy
--     (already the standard one) carries the rename automatically. See
--     this PR's Uncertainties for the evidence trail.
-- ---------------------------------------------------------------------------

-- 1. Column renames FIRST (so later steps' catalog introspection --
--    pg_get_constraintdef, policy expressions -- already reflect the new
--    column names).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'client_id'
  LOOP
    EXECUTE format('ALTER TABLE %I RENAME COLUMN client_id TO account_id', r.table_name);
  END LOOP;
END $$;

ALTER TABLE rubric RENAME COLUMN scope_client_id TO scope_account_id;

-- 2. Table renames.
ALTER TABLE client RENAME TO account;
ALTER TABLE client_payment_policy RENAME TO account_payment_policy;

-- 3. Index/constraint renames, computed from the live catalog.
DO $$
DECLARE
  r record;
  new_name text;
BEGIN
  -- Foreign-key and check constraints: plain rename (all confirmed short
  -- enough that a straight substitution never approaches the 63-byte
  -- limit).
  FOR r IN
    SELECT conname, conrelid::regclass::text AS tbl
    FROM pg_constraint
    WHERE contype IN ('f', 'c') AND conname LIKE '%client%'
  LOOP
    new_name := replace(r.conname, 'client', 'account');
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', r.tbl, r.conname, new_name);
  END LOOP;

  -- Plain (non-constraint-backed) indexes: plain rename, with a hard guard
  -- against silent Postgres truncation if a future table addition ever
  -- makes one of these long enough to matter.
  FOR r IN
    SELECT indexname
    FROM pg_indexes
    WHERE indexname LIKE '%client%'
      AND indexname NOT IN (SELECT conname FROM pg_constraint WHERE contype IN ('u', 'p'))
  LOOP
    new_name := replace(r.indexname, 'client', 'account');
    IF length(new_name) > 63 THEN
      RAISE EXCEPTION 'Renamed index name too long: % -> %', r.indexname, new_name;
    END IF;
    EXECUTE format('ALTER INDEX %I RENAME TO %I', r.indexname, new_name);
  END LOOP;

  -- UNIQUE / PRIMARY KEY constraints: plain rename when it fits under
  -- NAMEDATALEN; otherwise drop and re-add unnamed so Postgres computes its
  -- own correctly-truncated auto-name from the (already renamed) columns,
  -- rather than risking a mis-truncated or colliding name from manual
  -- string substitution.
  FOR r IN
    SELECT conname, conrelid::regclass::text AS tbl, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE contype IN ('u', 'p') AND conname LIKE '%client%'
  LOOP
    new_name := replace(r.conname, 'client', 'account');
    IF length(new_name) <= 63 THEN
      EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', r.tbl, r.conname, new_name);
    ELSE
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
      EXECUTE format('ALTER TABLE %s ADD %s', r.tbl, r.def);
    END IF;
  END LOOP;
END $$;

-- 4. membership_role enum values.
ALTER TYPE membership_role RENAME VALUE 'client_viewer' TO 'account_viewer';
ALTER TYPE membership_role RENAME VALUE 'client_admin' TO 'account_admin';

-- 5. RLS session-scope function: rename, then replace the body to read the
--    renamed GUC. The rename alone re-points every existing policy that
--    calls it (verified empirically); the CREATE OR REPLACE is required
--    separately because a function body is stored as text and does not
--    follow any rename.
ALTER FUNCTION app_current_client_ids() RENAME TO app_current_account_ids;

CREATE OR REPLACE FUNCTION app_current_account_ids()
RETURNS uuid[]
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    string_to_array(NULLIF(current_setting('app.current_account_ids', true), ''), ',')::uuid[],
    ARRAY[]::uuid[]
  );
$$;

-- 6. apply_tenant_rls(): update the generated-policy SQL to call the
--    renamed function. Existing policies are untouched (already migrated
--    by steps 1-5 above); this only affects any *future* call to
--    apply_tenant_rls() for a new tenant-scoped table.
CREATE OR REPLACE FUNCTION apply_tenant_rls(_table text, _col text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', _table);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', _table);
  EXECUTE format($f$
    CREATE POLICY tenant_isolation ON %1$I
      USING (
        %2$I IS NULL
        OR app_is_internal()
        OR %2$I = ANY (app_current_account_ids())
      )
      WITH CHECK (
        app_is_internal()
        OR %2$I = ANY (app_current_account_ids())
      );
  $f$, _table, _col);
END
$$;

-- Down Migration
-- ---------------------------------------------------------------------------
-- Mirrors the Up migration in reverse. Constraint/index names that were
-- drop+re-added (rather than plain-renamed) on the way up are drop+re-added
-- again on the way down -- same reasoning: let Postgres regenerate its own
-- correctly-truncated name under the (again client_id-named) columns rather
-- than hand-computing the exact original truncated string.
--
-- Every dynamic "%account%" sweep below excludes ba_% (better-auth's
-- ba_account/ba_session/ba_verification tables): "account" is not a virgin
-- term the way "client" was going up -- better-auth's own OAuth
-- account-linking table already used it (ba_account, ba_account_pkey,
-- ba_account_user_id_fkey, ba_account_user_id_idx, ba_account.account_id),
-- confirmed via a live catalog check before writing this migration. A
-- blanket LIKE '%account%' here would incorrectly rename those too.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION apply_tenant_rls(_table text, _col text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', _table);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', _table);
  EXECUTE format($f$
    CREATE POLICY tenant_isolation ON %1$I
      USING (
        %2$I IS NULL
        OR app_is_internal()
        OR %2$I = ANY (app_current_client_ids())
      )
      WITH CHECK (
        app_is_internal()
        OR %2$I = ANY (app_current_client_ids())
      );
  $f$, _table, _col);
END
$$;

ALTER FUNCTION app_current_account_ids() RENAME TO app_current_client_ids;

CREATE OR REPLACE FUNCTION app_current_client_ids()
RETURNS uuid[]
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    string_to_array(NULLIF(current_setting('app.current_client_ids', true), ''), ',')::uuid[],
    ARRAY[]::uuid[]
  );
$$;

ALTER TYPE membership_role RENAME VALUE 'account_viewer' TO 'client_viewer';
ALTER TYPE membership_role RENAME VALUE 'account_admin' TO 'client_admin';

DO $$
DECLARE
  r record;
  new_name text;
BEGIN
  FOR r IN
    SELECT conname, conrelid::regclass::text AS tbl, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE contype IN ('u', 'p') AND conname LIKE '%account%'
      AND conrelid::regclass::text NOT LIKE 'ba\_%'
  LOOP
    new_name := replace(r.conname, 'account', 'client');
    IF length(new_name) <= 63 THEN
      EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', r.tbl, r.conname, new_name);
    ELSE
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
      EXECUTE format('ALTER TABLE %s ADD %s', r.tbl, r.def);
    END IF;
  END LOOP;

  FOR r IN
    SELECT indexname
    FROM pg_indexes
    WHERE indexname LIKE '%account%'
      AND tablename NOT LIKE 'ba\_%'
      AND indexname NOT IN (SELECT conname FROM pg_constraint WHERE contype IN ('u', 'p'))
  LOOP
    new_name := replace(r.indexname, 'account', 'client');
    EXECUTE format('ALTER INDEX %I RENAME TO %I', r.indexname, new_name);
  END LOOP;

  FOR r IN
    SELECT conname, conrelid::regclass::text AS tbl
    FROM pg_constraint
    WHERE contype IN ('f', 'c') AND conname LIKE '%account%'
      AND conrelid::regclass::text NOT LIKE 'ba\_%'
  LOOP
    new_name := replace(r.conname, 'account', 'client');
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', r.tbl, r.conname, new_name);
  END LOOP;
END $$;

ALTER TABLE account_payment_policy RENAME TO client_payment_policy;
ALTER TABLE account RENAME TO client;

ALTER TABLE rubric RENAME COLUMN scope_account_id TO scope_client_id;

DO $$
DECLARE
  r record;
BEGIN
  -- Excludes ba_account itself: its own account_id column is better-auth's
  -- OAuth provider-account id, not this domain's tenant id (see header note).
  FOR r IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'account_id'
      AND table_name != 'ba_account'
  LOOP
    EXECUTE format('ALTER TABLE %I RENAME COLUMN account_id TO client_id', r.table_name);
  END LOOP;
END $$;
