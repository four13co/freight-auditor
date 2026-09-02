-- Up Migration
-- ---------------------------------------------------------------------------
-- 0071: rule_backtest/rule_backtest_case (0031) and charge_alignment_member
-- (0024) each defined their own tenant_isolation policy checking
-- current_setting('app.client_id', true)::uuid. That GUC is never set anywhere
-- in the app — tenant-context.ts (0009+) sets app.current_client_ids (plural)
-- and app.is_internal only. With FORCE ROW LEVEL SECURITY, the unset GUC makes
-- every USING/WITH CHECK evaluate NULL, i.e. always fails: persistBacktest
-- throws a live RLS violation against a real connection, and
-- promoteShadowRule's backtest-existence check always sees zero rows, so
-- POST /api/rules/:id/activate can never succeed (ClickUp 86e32tfw8).
--
-- Fails closed today (not a leak) — replace the broken predicate with
-- apply_tenant_rls (0009), the same app_current_client_ids()-based predicate
-- every other tenant table uses, matching the contract_rate precedent (0012).
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS tenant_isolation_rule_backtest ON rule_backtest;
DROP POLICY IF EXISTS tenant_isolation_rule_backtest_case ON rule_backtest_case;
DROP POLICY IF EXISTS tenant_isolation_charge_alignment_member ON charge_alignment_member;

SELECT apply_tenant_rls('rule_backtest', 'client_id');
SELECT apply_tenant_rls('rule_backtest_case', 'client_id');
SELECT apply_tenant_rls('charge_alignment_member', 'client_id');

-- Down Migration
DROP POLICY IF EXISTS tenant_isolation ON rule_backtest;
DROP POLICY IF EXISTS tenant_isolation ON rule_backtest_case;
DROP POLICY IF EXISTS tenant_isolation ON charge_alignment_member;

CREATE POLICY tenant_isolation_rule_backtest ON rule_backtest
  USING (client_id = current_setting('app.client_id', true)::uuid)
  WITH CHECK (client_id = current_setting('app.client_id', true)::uuid);
CREATE POLICY tenant_isolation_rule_backtest_case ON rule_backtest_case
  USING (client_id = current_setting('app.client_id', true)::uuid)
  WITH CHECK (client_id = current_setting('app.client_id', true)::uuid);
CREATE POLICY tenant_isolation_charge_alignment_member ON charge_alignment_member
  USING (client_id = current_setting('app.client_id', true)::uuid)
  WITH CHECK (client_id = current_setting('app.client_id', true)::uuid);
