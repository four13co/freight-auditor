-- Up Migration
-- ---------------------------------------------------------------------------
-- 0079 (86e36zket): the generic rule lifecycle (POST /api/rules/:id/ratify
-- then /activate) activates GLOBAL rule/rule_version rows -- no client_id,
-- no single tenant to attribute evidence to -- via a corpus backtest with
-- caller-supplied cases. rule_backtest.client_id and rule_backtest_case.
-- client_id were NOT NULL (0031), so nothing in that real lifecycle could
-- ever produce a row (86e367r9q's Problem statement).
--
-- apply_tenant_rls (0009), already wired onto both tables by 0071, treats a
-- NULL tenant column as a shared/global-visible row (IS NULL OR
-- app_is_internal() OR client_id = ANY(app_current_client_ids())) -- so the
-- RLS policy needs no change, only the stale column constraint. Zero real
-- rows exist today (persistBacktest has never had a real production caller),
-- so this is a pure constraint relaxation with no backfill.
-- ---------------------------------------------------------------------------
ALTER TABLE rule_backtest ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE rule_backtest_case ALTER COLUMN client_id DROP NOT NULL;

-- Down Migration
ALTER TABLE rule_backtest_case ALTER COLUMN client_id SET NOT NULL;
ALTER TABLE rule_backtest ALTER COLUMN client_id SET NOT NULL;
