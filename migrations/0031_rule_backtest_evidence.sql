-- Up Migration
CREATE TABLE rule_backtest (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid NOT NULL REFERENCES client(id),
  rule_version_id uuid NOT NULL REFERENCES rule_version(id), corpus_hash char(64) NOT NULL,
  passed boolean NOT NULL, pass_count integer NOT NULL, regression_count integer NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(), UNIQUE (client_id, rule_version_id, corpus_hash)
);
CREATE TABLE rule_backtest_case (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid NOT NULL REFERENCES client(id),
  backtest_id uuid NOT NULL REFERENCES rule_backtest(id), case_key text NOT NULL, passed boolean NOT NULL,
  input_hash char(64) NOT NULL, expected_hash char(64) NOT NULL, actual_hash char(64) NOT NULL, actual jsonb NOT NULL,
  UNIQUE (backtest_id, case_key)
);
CREATE INDEX rule_backtest_client_idx ON rule_backtest (client_id, rule_version_id, recorded_at DESC);
ALTER TABLE rule_backtest ENABLE ROW LEVEL SECURITY; ALTER TABLE rule_backtest FORCE ROW LEVEL SECURITY;
ALTER TABLE rule_backtest_case ENABLE ROW LEVEL SECURITY; ALTER TABLE rule_backtest_case FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_rule_backtest ON rule_backtest USING (client_id=current_setting('app.client_id',true)::uuid) WITH CHECK (client_id=current_setting('app.client_id',true)::uuid);
CREATE POLICY tenant_isolation_rule_backtest_case ON rule_backtest_case USING (client_id=current_setting('app.client_id',true)::uuid) WITH CHECK (client_id=current_setting('app.client_id',true)::uuid);
GRANT SELECT, INSERT ON rule_backtest, rule_backtest_case TO freight_app;

-- Down Migration
DROP TABLE IF EXISTS rule_backtest_case; DROP TABLE IF EXISTS rule_backtest;
