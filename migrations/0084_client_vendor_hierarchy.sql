-- Up Migration
-- ---------------------------------------------------------------------------
-- 0084 (86e3a76bz): real backend for the Client (middle tier) and Vendor
-- (bottom tier) entities the UI-REBUILD epics already ship screens for
-- against web/src/lib/in-memory-hierarchy-store.ts (a deliberate,
-- session-lifetime stand-in -- see that module's header comment). Hierarchy
-- is now Account -> Client -> Vendor (three levels; "Grand Client" is
-- retired terminology, never used here -- Greg, task comment 2026-09-18).
--
-- Design decisions made by Build per this task's own acceptance criteria
-- (each one explicitly left open by Plan's reshape), restated here so the
-- migration's rationale travels with the schema itself, not just the PR:
--
-- 1. TABLE SHAPE -- denormalized ancestor-chain columns (decision 4, task
--    comment 2026-09-18), the direct generalization of apply_tenant_rls()'s
--    existing single-column-per-table pattern (migration 0009): `client`
--    carries account_id (its one ancestor); `vendor` carries BOTH account_id
--    and client_id (its two ancestors). Neither is a shared/catalog table
--    (unlike some of 0009's pairs), so account_id is NOT NULL on both --
--    no "shared row" case that a NULL tenant column represents elsewhere.
--
-- 2. MEMBERSHIP_ROLE ENUM -- adding client_scope_viewer/client_scope_admin
--    and vendor_scope_viewer/vendor_scope_admin, DELIBERATELY NOT reusing
--    the client_viewer/client_admin literals migration 0083 freed when it
--    renamed the tenant-root role values to account_viewer/account_admin.
--    Reuse was considered and rejected: src/modules/identity/tenant-admin-auth.ts's
--    own header comment (line ~18, unrenamed by 0083) still reads "a portal
--    (client_viewer/client_admin) session" meaning the OLD tenant-root
--    sense -- live evidence in the current tree that the bare strings
--    already carry a different, incompatible meaning elsewhere. Reusing them
--    for the NEW middle-tier Client would make `grep -rn client_viewer`
--    return two unrelated meanings with nothing at the call site to tell
--    them apart. The `_scope_` infix reads clearly as "role scoped to this
--    entity level" and greps cleanly away from the retired meaning.
--
-- 3. MEMBERSHIP TABLE SHAPE -- extending membership with nullable client_id
--    and vendor_id columns (decision 5), populated according to how deep the
--    membership is actually scoped (an Account-level membership leaves both
--    NULL; a Client-level membership sets client_id; a Vendor-level
--    membership sets both client_id and vendor_id) -- same ancestor-chain
--    convention as the two new entity tables, not a polymorphic FK.
--
--    This REQUIRES replacing the existing UNIQUE (user_id, account_id)
--    constraint (membership_user_id_account_id_key, migration 0003 as
--    renamed by 0083): under decision 2 ("a user can belong directly to an
--    Account, a Client, OR a Vendor"), a single user can legitimately hold
--    an Account-level membership AND a separate Client-level membership
--    within the SAME account -- both rows carry the same account_id
--    (ancestor chain), which the old constraint would reject as a duplicate.
--    Replaced with a unique index on (user_id, the row's actual scope --
--    COALESCE(vendor_id, client_id, account_id)), so uniqueness is keyed on
--    the exact entity the membership grants a role at, not on the ancestor
--    account alone. This is a constraint REPLACEMENT, not a data-destructive
--    change, under the same pre-launch exception migration 0083 already
--    exercised (Greg, via Bridge, on 86e3ankd7: "system hasn't launched --
--    no live users, no production data at risk") -- the second use of that
--    exception, named explicitly here per this task's own instruction not to
--    make this change silently.
--
-- 4. RLS -- extends the apply_tenant_rls() pattern to both new tables
--    WITHOUT modifying apply_tenant_rls() itself (that function is called by
--    34+ existing tables; changing its generated-policy SQL would silently
--    alter all of them). A new sibling function, apply_hierarchical_tenant_rls,
--    generates a `tenant_isolation` policy (same name the schema guard test
--    at test/db/tenant-rls-schema-guard.db.test.ts requires) that ORs
--    together: app_is_internal(), an Account-scope check against the
--    existing app_current_account_ids() GUC (a single-column comparison on
--    account_id, unchanged for an Account-scoped caller -- decision 4's own
--    stated goal), a Client-scope check against a NEW
--    app_current_scoped_client_ids() GUC, and (on `vendor` only) a
--    Vendor-scope check against a NEW app_current_scoped_vendor_ids() GUC.
--
--    NAMING: deliberately NOT app_current_client_ids()/app.current_client_ids
--    -- migration 0001 originally defined exactly that function/GUC pair for
--    the OLD tenant-root scope, before 0083 renamed it to
--    app_current_account_ids()/app.current_account_ids. Reusing the freed
--    name for this NEW, different meaning (Client-ENTITY scope, one level
--    below Account) would repeat the exact collision decision 2's own
--    caution warns against for the enum literals -- so the `_scoped_` infix
--    disambiguates here too, same reasoning, same fix.
--
--    IMPORTANT: the Client/Vendor-scope GUC branches are DORMANT as of this
--    migration -- setTenantTxScope (src/db/tenant-context.ts) now sets both
--    new GUCs (defaulting empty), but no request-auth resolver anywhere
--    populates them from a real Client- or Vendor-scoped membership yet. The
--    only sessions that exist today are internal (app_is_internal(), admits
--    everything) or Account-scoped (app_current_account_ids(), works exactly
--    as before). Wiring portal session resolution for a user whose ONLY
--    membership is Client- or Vendor-scoped is explicitly out of scope for
--    this migration/PR (it reaches into the portal auth resolver, a separate
--    surface) and is named as a fast-follow in this PR's description.
-- ---------------------------------------------------------------------------

CREATE TABLE client (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES account(id),
  name        text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, name)
);

-- Composite indexes LEAD with the tenant key (§6.10 convention, migration 0003).
CREATE INDEX client_account_idx ON client (account_id);

-- This table lands after 0010's dynamic full-CRUD grant already ran, so
-- grant explicitly here (mutable admin-managed entity, not append-only --
-- matches contract_rate's precedent, migration 0011).
GRANT SELECT, INSERT, UPDATE, DELETE ON client TO freight_app;

CREATE TABLE vendor (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES account(id),
  client_id    uuid NOT NULL REFERENCES client(id),
  name         text NOT NULL,
  contact_info text,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, name)
);

CREATE INDEX vendor_account_client_idx ON vendor (account_id, client_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON vendor TO freight_app;

-- membership_role: new Client- and Vendor-level values (decision 2 above).
-- Postgres enums only support additive ALTER TYPE ... ADD VALUE, matching
-- this repo's established additive-schema convention (0017/0052/0070
-- precedent) -- and per that same precedent, NOT used elsewhere in this same
-- migration transaction (PG forbids referencing a just-added enum value
-- before the transaction that added it commits).
ALTER TYPE membership_role ADD VALUE 'client_scope_viewer';
ALTER TYPE membership_role ADD VALUE 'client_scope_admin';
ALTER TYPE membership_role ADD VALUE 'vendor_scope_viewer';
ALTER TYPE membership_role ADD VALUE 'vendor_scope_admin';

-- membership: ancestor-chain scope columns (decision 3 above).
ALTER TABLE membership ADD COLUMN client_id uuid REFERENCES client(id);
ALTER TABLE membership ADD COLUMN vendor_id uuid REFERENCES vendor(id);

ALTER TABLE membership DROP CONSTRAINT membership_user_id_account_id_key;
CREATE UNIQUE INDEX membership_user_scope_uniq
  ON membership (user_id, COALESCE(vendor_id, client_id, account_id));

-- New GUC-reading functions, mirroring app_current_account_ids()'s shape --
-- named app_current_scoped_*_ids (not app_current_client_ids(), which is a
-- freed-but-historically-loaded name -- see this migration's header comment
-- point 4 for why).
CREATE OR REPLACE FUNCTION app_current_scoped_client_ids()
RETURNS uuid[]
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    string_to_array(NULLIF(current_setting('app.current_scoped_client_ids', true), ''), ',')::uuid[],
    ARRAY[]::uuid[]
  );
$$;

CREATE OR REPLACE FUNCTION app_current_scoped_vendor_ids()
RETURNS uuid[]
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    string_to_array(NULLIF(current_setting('app.current_scoped_vendor_ids', true), ''), ',')::uuid[],
    ARRAY[]::uuid[]
  );
$$;

-- Hierarchical RLS applier (decision 4 above) -- a sibling to
-- apply_tenant_rls(), not a modification of it. _client_expr/_vendor_expr
-- are SQL expressions over the target table's OWN columns (not identifiers
-- to quote), evaluated against the corresponding scope GUC; _vendor_expr may
-- be NULL for a table with no vendor level beneath it.
CREATE OR REPLACE FUNCTION apply_hierarchical_tenant_rls(
  _table text,
  _account_col text,
  _client_expr text,
  _vendor_expr text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  vendor_clause text;
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', _table);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', _table);

  vendor_clause := CASE
    WHEN _vendor_expr IS NULL THEN 'false'
    ELSE format('%s = ANY (app_current_scoped_vendor_ids())', _vendor_expr)
  END;

  EXECUTE format($f$
    CREATE POLICY tenant_isolation ON %1$I
      USING (
        app_is_internal()
        OR %2$I = ANY (app_current_account_ids())
        OR %3$s = ANY (app_current_scoped_client_ids())
        OR %4$s
      )
      WITH CHECK (
        app_is_internal()
        OR %2$I = ANY (app_current_account_ids())
        OR %3$s = ANY (app_current_scoped_client_ids())
        OR %4$s
      );
  $f$, _table, _account_col, _client_expr, vendor_clause);
END
$$;

-- client: a Client-scoped session sees its OWN row via `id` matched against
-- app_current_scoped_client_ids(); no vendor level beneath a client row itself.
SELECT apply_hierarchical_tenant_rls('client', 'account_id', 'id', NULL);

-- vendor: a Client-scoped session sees every vendor under ITS client via
-- `client_id`; a Vendor-scoped session sees its own row via `id`.
SELECT apply_hierarchical_tenant_rls('vendor', 'account_id', 'client_id', 'id');

-- Down Migration
-- ---------------------------------------------------------------------------
-- Mirrors the Up migration in reverse. Postgres has no DROP VALUE for enums
-- (0017/0052/0070 precedent) -- the four ADD VALUE calls above are left as a
-- documented no-op, consistent with the irreversibility Postgres itself
-- imposes here.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS tenant_isolation ON vendor;
DROP POLICY IF EXISTS tenant_isolation ON client;
ALTER TABLE vendor NO FORCE ROW LEVEL SECURITY;
ALTER TABLE vendor DISABLE ROW LEVEL SECURITY;
ALTER TABLE client NO FORCE ROW LEVEL SECURITY;
ALTER TABLE client DISABLE ROW LEVEL SECURITY;

DROP FUNCTION IF EXISTS apply_hierarchical_tenant_rls(text, text, text, text);
DROP FUNCTION IF EXISTS app_current_scoped_vendor_ids();
DROP FUNCTION IF EXISTS app_current_scoped_client_ids();

DROP INDEX IF EXISTS membership_user_scope_uniq;
ALTER TABLE membership ADD CONSTRAINT membership_user_id_account_id_key UNIQUE (user_id, account_id);

ALTER TABLE membership DROP COLUMN vendor_id;
ALTER TABLE membership DROP COLUMN client_id;

REVOKE ALL ON vendor FROM freight_app;
DROP TABLE IF EXISTS vendor;
REVOKE ALL ON client FROM freight_app;
DROP TABLE IF EXISTS client;
