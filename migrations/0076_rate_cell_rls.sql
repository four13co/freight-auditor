-- Up Migration
-- ---------------------------------------------------------------------------
-- 0076: apply the tenant RLS policy to rate_cell (86e2zfjrj).
--
-- rate_cell (0026_finding_citations) has always carried a mandatory
-- client_id column and a freight_app grant, but 0026 never called
-- apply_tenant_rls -- unlike every sibling table added since 0009, which
-- each call it for their own new table. That gap sat live: relrowsecurity
-- and relforcerowsecurity were both false, so a tenant-scoped app-role
-- query against rate_cell had no DB-enforced isolation at all, found by
-- 86e2zfjrj's new schema-wide guard test enumerating every client_id/
-- tenant_id/scope_client_id column and asserting FORCE RLS on each.
--
-- Zero-risk fix: no source module or test ever inserts into rate_cell (only
-- reads it via a LEFT JOIN already scoped by the driving row's client_id --
-- get-defensibility-chain.ts), so there is no existing write path the new
-- WITH CHECK predicate could reject and no seeded fixture that could start
-- failing.
-- ---------------------------------------------------------------------------

SELECT apply_tenant_rls('rate_cell', 'client_id');

-- Down Migration
DROP POLICY IF EXISTS tenant_isolation ON rate_cell;
ALTER TABLE rate_cell NO FORCE ROW LEVEL SECURITY;
ALTER TABLE rate_cell DISABLE ROW LEVEL SECURITY;
