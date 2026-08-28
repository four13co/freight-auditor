-- Up Migration
ALTER TABLE rule_version DROP CONSTRAINT contract_proposal_rule_version_is_shadow;
DROP INDEX rule_version_contract_proposal_idx;
ALTER TABLE rule_version ADD COLUMN human_ratified_by uuid REFERENCES app_user(id);
ALTER TABLE rule_version ADD COLUMN human_ratification_rationale text;
ALTER TABLE rule_version ADD CONSTRAINT contract_proposal_rule_version_governance CHECK (
  source_contract_rule_proposal_id IS NULL OR
  (source_contract_rule_proposal_backtest_id IS NOT NULL AND (
    (lifecycle_state='SHADOW' AND human_ratified_by IS NULL AND human_ratification_rationale IS NULL) OR
    (lifecycle_state='ACTIVE' AND hardness='FIRM_RULE' AND human_ratified_by IS NOT NULL
      AND length(trim(human_ratification_rationale)) > 0 AND predecessor_rule_version_id IS NOT NULL)
  ))
);
CREATE UNIQUE INDEX rule_version_contract_proposal_lifecycle_idx
  ON rule_version(source_contract_rule_proposal_id,lifecycle_state) WHERE source_contract_rule_proposal_id IS NOT NULL;

ALTER TABLE promotion_event ADD COLUMN contract_proposal_backtest_id uuid REFERENCES contract_rule_proposal_backtest(id);
ALTER TABLE promotion_event DROP CONSTRAINT active_promotion_requires_rule_backtest;
ALTER TABLE promotion_event ADD CONSTRAINT active_promotion_requires_backtest
  CHECK (to_lifecycle <> 'ACTIVE' OR rule_backtest_id IS NOT NULL OR contract_proposal_backtest_id IS NOT NULL);

CREATE TABLE contract_rule_proposal_ratification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid NOT NULL REFERENCES client(id),
  acceptance_id uuid NOT NULL REFERENCES contract_rule_proposal_acceptance(id),
  proposal_id uuid NOT NULL REFERENCES contract_rule_proposal(id),
  backtest_id uuid NOT NULL REFERENCES contract_rule_proposal_backtest(id),
  shadow_rule_version_id uuid NOT NULL REFERENCES rule_version(id),
  active_rule_version_id uuid NOT NULL REFERENCES rule_version(id),
  ratified_by uuid NOT NULL REFERENCES app_user(id), rationale text NOT NULL CHECK(length(trim(rationale))>0),
  recorded_at timestamptz NOT NULL DEFAULT now(), UNIQUE(client_id,acceptance_id), UNIQUE(client_id,active_rule_version_id)
);
SELECT apply_tenant_rls('contract_rule_proposal_ratification','client_id');
GRANT SELECT,INSERT ON contract_rule_proposal_ratification TO freight_app;

-- Down Migration
REVOKE ALL ON contract_rule_proposal_ratification FROM freight_app;
DROP TABLE IF EXISTS contract_rule_proposal_ratification;
ALTER TABLE promotion_event DROP CONSTRAINT active_promotion_requires_backtest;
ALTER TABLE promotion_event DROP COLUMN contract_proposal_backtest_id;
ALTER TABLE promotion_event ADD CONSTRAINT active_promotion_requires_rule_backtest CHECK(to_lifecycle <> 'ACTIVE' OR rule_backtest_id IS NOT NULL) NOT VALID;
DROP INDEX rule_version_contract_proposal_lifecycle_idx;
ALTER TABLE rule_version DROP CONSTRAINT contract_proposal_rule_version_governance;
ALTER TABLE rule_version DROP COLUMN human_ratification_rationale;
ALTER TABLE rule_version DROP COLUMN human_ratified_by;
CREATE UNIQUE INDEX rule_version_contract_proposal_idx ON rule_version(source_contract_rule_proposal_id) WHERE source_contract_rule_proposal_id IS NOT NULL;
ALTER TABLE rule_version ADD CONSTRAINT contract_proposal_rule_version_is_shadow CHECK(source_contract_rule_proposal_id IS NULL OR (lifecycle_state='SHADOW' AND source_contract_rule_proposal_backtest_id IS NOT NULL));
