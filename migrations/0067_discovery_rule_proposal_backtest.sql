-- Up Migration
-- P3.D.7: immutable deterministic backtest evidence for discovery-sourced
-- proposal-only rules, mirroring 0041's contract_rule_proposal_backtest.
CREATE TABLE discovery_rule_proposal_backtest (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES client(id),
  proposal_id uuid NOT NULL REFERENCES discovery_rule_proposal(id),
  corpus_schema_version text NOT NULL,
  corpus_hash char(64) NOT NULL CHECK (corpus_hash ~ '^[a-f0-9]{64}$'),
  proposal_hash char(64) NOT NULL CHECK (proposal_hash ~ '^[a-f0-9]{64}$'),
  ast_hash char(64) NOT NULL CHECK (ast_hash ~ '^[a-f0-9]{64}$'),
  passed boolean NOT NULL,
  pass_count integer NOT NULL CHECK (pass_count >= 0),
  regression_count integer NOT NULL CHECK (regression_count >= 0),
  actor_user_id uuid NOT NULL REFERENCES app_user(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (pass_count + regression_count > 0),
  UNIQUE (client_id, proposal_id, corpus_hash)
);

CREATE TABLE discovery_rule_proposal_backtest_case (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES client(id),
  backtest_id uuid NOT NULL REFERENCES discovery_rule_proposal_backtest(id),
  case_key text NOT NULL,
  facts jsonb NOT NULL CHECK (jsonb_typeof(facts) = 'object'),
  expected_verdict text NOT NULL CHECK (expected_verdict IN ('PASS', 'FAIL', 'UNASSESSABLE')),
  actual_verdict text NOT NULL CHECK (actual_verdict IN ('PASS', 'FAIL', 'UNASSESSABLE')),
  passed boolean NOT NULL,
  input_hash char(64) NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  expected_hash char(64) NOT NULL CHECK (expected_hash ~ '^[a-f0-9]{64}$'),
  actual_hash char(64) NOT NULL CHECK (actual_hash ~ '^[a-f0-9]{64}$'),
  evaluated_ast jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, backtest_id, case_key)
);

CREATE INDEX discovery_rule_proposal_backtest_idx
  ON discovery_rule_proposal_backtest (client_id, proposal_id, recorded_at DESC);
SELECT apply_tenant_rls('discovery_rule_proposal_backtest', 'client_id');
SELECT apply_tenant_rls('discovery_rule_proposal_backtest_case', 'client_id');
GRANT SELECT, INSERT ON discovery_rule_proposal_backtest, discovery_rule_proposal_backtest_case TO freight_app;

-- Down Migration
REVOKE ALL ON discovery_rule_proposal_backtest_case, discovery_rule_proposal_backtest FROM freight_app;
DROP TABLE IF EXISTS discovery_rule_proposal_backtest_case;
DROP TABLE IF EXISTS discovery_rule_proposal_backtest;
