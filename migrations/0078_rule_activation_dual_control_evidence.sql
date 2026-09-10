-- Up Migration
-- 86e367r9q: promoteShadowRule's SHADOW->ACTIVE gate no longer requires a
-- rule_backtest row -- rule/rule_version are GLOBAL tables (no client_id),
-- but rule_backtest.client_id is NOT NULL, so nothing in the real generic
-- rule lifecycle (POST /api/rules/:id/ratify then /activate) could ever
-- produce one; every real activation threw (this task's own Problem
-- section). This table's own CHECK constraint (0043) enforced the same
-- requirement one layer below the app code and would still reject every
-- real activation even after the app-level fix, so it widens here too.
--
-- dual_control_analyst_id records the activating analyst once
-- promoteShadowRule has confirmed they are a DIFFERENT analyst than
-- whoever ratified this rule version to SHADOW (see promote-shadow-rule.ts)
-- -- real evidence of the compensating control the product decision called
-- for, not a rubber stamp column with nothing behind it.
ALTER TABLE promotion_event ADD COLUMN dual_control_analyst_id uuid REFERENCES app_user(id);
ALTER TABLE promotion_event DROP CONSTRAINT active_promotion_requires_backtest;
ALTER TABLE promotion_event ADD CONSTRAINT active_promotion_requires_backtest CHECK (
  to_lifecycle <> 'ACTIVE' OR rule_backtest_id IS NOT NULL OR contract_proposal_backtest_id IS NOT NULL
    OR dual_control_analyst_id IS NOT NULL
);

-- Down Migration
ALTER TABLE promotion_event DROP CONSTRAINT active_promotion_requires_backtest;
ALTER TABLE promotion_event ADD CONSTRAINT active_promotion_requires_backtest CHECK (
  to_lifecycle <> 'ACTIVE' OR rule_backtest_id IS NOT NULL OR contract_proposal_backtest_id IS NOT NULL
);
ALTER TABLE promotion_event DROP COLUMN dual_control_analyst_id;
