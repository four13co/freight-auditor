-- Up Migration
-- P3.C.9: a human acceptance may create SHADOW evidence, never ACTIVE.
ALTER TABLE rule_version ADD COLUMN source_contract_rule_proposal_id uuid REFERENCES contract_rule_proposal(id);
ALTER TABLE rule_version ADD COLUMN source_contract_rule_proposal_backtest_id uuid REFERENCES contract_rule_proposal_backtest(id);
ALTER TABLE rule_version ADD CONSTRAINT contract_proposal_rule_version_is_shadow CHECK (
  source_contract_rule_proposal_id IS NULL OR
  (lifecycle_state = 'SHADOW' AND source_contract_rule_proposal_backtest_id IS NOT NULL)
);
CREATE UNIQUE INDEX rule_version_contract_proposal_idx ON rule_version(source_contract_rule_proposal_id)
  WHERE source_contract_rule_proposal_id IS NOT NULL;

CREATE TABLE contract_rule_proposal_acceptance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES client(id),
  proposal_id uuid NOT NULL REFERENCES contract_rule_proposal(id),
  backtest_id uuid NOT NULL REFERENCES contract_rule_proposal_backtest(id),
  shadow_rule_version_id uuid NOT NULL REFERENCES rule_version(id),
  accepted_by uuid NOT NULL REFERENCES app_user(id),
  rationale text NOT NULL CHECK (length(trim(rationale)) > 0),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(client_id, proposal_id),
  UNIQUE(client_id, shadow_rule_version_id)
);
SELECT apply_tenant_rls('contract_rule_proposal_acceptance', 'client_id');
GRANT SELECT, INSERT ON contract_rule_proposal_acceptance TO freight_app;

-- Down Migration
REVOKE ALL ON contract_rule_proposal_acceptance FROM freight_app;
DROP TABLE IF EXISTS contract_rule_proposal_acceptance;
DROP INDEX IF EXISTS rule_version_contract_proposal_idx;
ALTER TABLE rule_version DROP CONSTRAINT IF EXISTS contract_proposal_rule_version_is_shadow;
ALTER TABLE rule_version DROP COLUMN IF EXISTS source_contract_rule_proposal_backtest_id;
ALTER TABLE rule_version DROP COLUMN IF EXISTS source_contract_rule_proposal_id;
