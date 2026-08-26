-- Up Migration
ALTER TABLE promotion_event ADD COLUMN rule_backtest_id uuid REFERENCES rule_backtest(id);
ALTER TABLE promotion_event ADD CONSTRAINT active_promotion_requires_rule_backtest
  CHECK (to_lifecycle <> 'ACTIVE' OR rule_backtest_id IS NOT NULL) NOT VALID;

-- Down Migration
ALTER TABLE promotion_event DROP CONSTRAINT IF EXISTS active_promotion_requires_rule_backtest;
ALTER TABLE promotion_event DROP COLUMN IF EXISTS rule_backtest_id;
