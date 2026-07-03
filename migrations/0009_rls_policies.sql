-- Up Migration
-- ---------------------------------------------------------------------------
-- 0009: Row-Level Security (Master Spec §11, §1.7).
--
-- Isolation is enforced in the DB kernel, not by app WHERE clauses. Every
-- tenant table gets FORCE ROW LEVEL SECURITY + a policy that admits a row when
-- EITHER:
--   * the row is a shared catalog row (tenant column IS NULL), OR
--   * app_is_internal() is true (internal analyst → cross-client), OR
--   * the row's tenant column is in app_current_client_ids() (the request scope).
--
-- The policy reads the transaction-scoped GUCs set by the app via SET LOCAL
-- (runtime plumbing lands in Phase 0). FORCE makes the policy bind even for the
-- table owner; the app connects as the NON-superuser `freight_app` role so the
-- policy actually applies (superusers/BYPASSRLS roles are exempt by design).
--
-- Most tenant tables key on `client_id`; three rubric tables use a differently
-- named tenant column (rubric.scope_client_id, rubric_snapshot.tenant_id,
-- resolution_conflict.tenant_id), so the applier carries (table, column) pairs.
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

DO $$
DECLARE
  r record;
  -- (table, tenant-column) pairs. Default tenant column is client_id.
  pairs text[][] := ARRAY[
    ['membership','client_id'], ['charge_code_crosswalk','client_id'], ['source_document','client_id'],
    ['contract','client_id'], ['contract_version','client_id'], ['contract_amendment','client_id'], ['contract_clause','client_id'],
    ['human_override','client_id'], ['promotion_policy','client_id'],
    ['rubric','scope_client_id'], ['rubric_snapshot','tenant_id'], ['resolution_conflict','tenant_id'],
    ['transport_document','client_id'], ['shipment','client_id'], ['raw_edi_document','client_id'], ['invoice','client_id'], ['charge_fact','client_id'],
    ['audit_run','client_id'], ['expected_charge','client_id'], ['computation_trace','client_id'],
    ['gate_failure','client_id'], ['charge_finding','client_id'], ['charge_alignment','client_id'], ['variance_finding','client_id'],
    ['scorecard','client_id'], ['finding_status_event','client_id'],
    ['dispute','client_id'], ['dispute_line','client_id'], ['dispute_comm','client_id'], ['payment_gate_decision','client_id'],
    ['claim','client_id'], ['recovery_event','client_id'], ['extraction_field','client_id'], ['clarifying_question','client_id'],
    ['audit_event','client_id']
  ];
  i int;
BEGIN
  FOR i IN 1 .. array_length(pairs, 1) LOOP
    PERFORM apply_tenant_rls(pairs[i][1], pairs[i][2]);
  END LOOP;
END
$$;

-- Down Migration
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'membership', 'charge_code_crosswalk', 'source_document',
    'contract', 'contract_version', 'contract_amendment', 'contract_clause',
    'human_override', 'promotion_policy',
    'rubric', 'rubric_snapshot', 'resolution_conflict',
    'transport_document', 'shipment', 'raw_edi_document', 'invoice', 'charge_fact',
    'audit_run', 'expected_charge', 'computation_trace',
    'gate_failure', 'charge_finding', 'charge_alignment', 'variance_finding',
    'scorecard', 'finding_status_event',
    'dispute', 'dispute_line', 'dispute_comm', 'payment_gate_decision',
    'claim', 'recovery_event', 'extraction_field', 'clarifying_question',
    'audit_event'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', t);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY;', t);
  END LOOP;
END
$$;
DROP FUNCTION IF EXISTS apply_tenant_rls(text, text);
