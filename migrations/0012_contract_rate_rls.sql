-- Up Migration
-- ---------------------------------------------------------------------------
-- 0012: contract_rate is tenant-scoped (client_id, added in 0011) but was never
-- added to 0009's RLS pairs list, so the freight_app grants in 0011 currently
-- allow cross-tenant read/write. Add it additively, matching contract_clause's
-- wiring in 0009 (ClickUp 86e25ujwg).
-- ---------------------------------------------------------------------------

SELECT apply_tenant_rls('contract_rate', 'client_id');

-- Down Migration
DROP POLICY IF EXISTS tenant_isolation ON contract_rate;
ALTER TABLE contract_rate NO FORCE ROW LEVEL SECURITY;
ALTER TABLE contract_rate DISABLE ROW LEVEL SECURITY;
