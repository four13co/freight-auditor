-- Up Migration
-- P3.D.7: a human acceptance may create SHADOW evidence for a discovery
-- proposal, never ACTIVE -- mirroring 0042's contract_rule_proposal_acceptance.
-- Ratification to ACTIVE/FIRM_RULE is out of this task's scope (no analogue
-- to 0043 here): discovery proposals stop at SHADOW.
ALTER TABLE rule_version ADD COLUMN source_discovery_rule_proposal_id uuid REFERENCES discovery_rule_proposal(id);
ALTER TABLE rule_version ADD COLUMN source_discovery_rule_proposal_backtest_id uuid REFERENCES discovery_rule_proposal_backtest(id);
ALTER TABLE rule_version ADD CONSTRAINT discovery_proposal_rule_version_is_shadow CHECK (
  source_discovery_rule_proposal_id IS NULL OR
  (lifecycle_state = 'SHADOW' AND source_discovery_rule_proposal_backtest_id IS NOT NULL)
);
CREATE UNIQUE INDEX rule_version_discovery_proposal_idx ON rule_version(source_discovery_rule_proposal_id)
  WHERE source_discovery_rule_proposal_id IS NOT NULL;

CREATE TABLE discovery_rule_proposal_acceptance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES client(id),
  proposal_id uuid NOT NULL REFERENCES discovery_rule_proposal(id),
  backtest_id uuid NOT NULL REFERENCES discovery_rule_proposal_backtest(id),
  shadow_rule_version_id uuid NOT NULL REFERENCES rule_version(id),
  accepted_by uuid NOT NULL REFERENCES app_user(id),
  rationale text NOT NULL CHECK (length(trim(rationale)) > 0),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(client_id, proposal_id),
  UNIQUE(client_id, shadow_rule_version_id)
);
SELECT apply_tenant_rls('discovery_rule_proposal_acceptance', 'client_id');
GRANT SELECT, INSERT ON discovery_rule_proposal_acceptance TO freight_app;

-- Down Migration
REVOKE ALL ON discovery_rule_proposal_acceptance FROM freight_app;
DROP TABLE IF EXISTS discovery_rule_proposal_acceptance;
DROP INDEX IF EXISTS rule_version_discovery_proposal_idx;
ALTER TABLE rule_version DROP CONSTRAINT IF EXISTS discovery_proposal_rule_version_is_shadow;
ALTER TABLE rule_version DROP COLUMN IF EXISTS source_discovery_rule_proposal_backtest_id;
ALTER TABLE rule_version DROP COLUMN IF EXISTS source_discovery_rule_proposal_id;
