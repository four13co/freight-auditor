-- Up Migration
-- P3.D.6: generate rule-change proposals from P3.D discovery-trigger
-- evidence (unassessable results 0044, unknown charge codes 0059,
-- suspicious passes 0054) without ever activating them -- lifecycle_state
-- is pinned to PROPOSED by CHECK, exactly like contract_rule_proposal
-- (0040) pins its own AI-authored rows. Exactly-one-of-three trigger FK
-- (mirrors 0044's exactly-one-of-two variance_finding_id/gate_failure_id
-- discriminator) keeps real referential integrity across the three
-- heterogeneous P3.D trigger tables instead of an unconstrained
-- polymorphic id.
CREATE TABLE discovery_rule_proposal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES client(id),
  audit_run_id uuid NOT NULL REFERENCES audit_run(id),
  discovery_trigger_id uuid REFERENCES discovery_trigger(id),
  unknown_charge_code_trigger_id uuid REFERENCES unknown_charge_code_trigger(id),
  suspicious_pass_trigger_id uuid REFERENCES suspicious_pass_trigger(id),
  criterion_key text NOT NULL,
  kind criterion_kind NOT NULL CHECK (kind = 'SCORING'),
  rule_type rule_type NOT NULL,
  description text NOT NULL,
  ast jsonb NOT NULL,
  ast_hash char(64) NOT NULL CHECK (ast_hash ~ '^[a-f0-9]{64}$'),
  expected_inputs jsonb NOT NULL CHECK (jsonb_typeof(expected_inputs) = 'array'),
  lifecycle_state rule_lifecycle NOT NULL DEFAULT 'PROPOSED' CHECK (lifecycle_state = 'PROPOSED'),
  proposal_schema_version text NOT NULL,
  provider text NOT NULL CHECK (provider = 'anthropic'),
  model_id text NOT NULL,
  prompt_version text NOT NULL,
  provider_message_id text NOT NULL,
  request_key char(64) NOT NULL CHECK (request_key ~ '^[a-f0-9]{64}$'),
  proposal_hash char(64) NOT NULL CHECK (proposal_hash ~ '^[a-f0-9]{64}$'),
  actor_user_id uuid REFERENCES app_user(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((discovery_trigger_id IS NOT NULL)::int + (unknown_charge_code_trigger_id IS NOT NULL)::int
    + (suspicious_pass_trigger_id IS NOT NULL)::int = 1),
  UNIQUE (client_id, proposal_hash)
);
CREATE INDEX discovery_rule_proposal_run_idx ON discovery_rule_proposal (client_id, audit_run_id, recorded_at);

SELECT apply_tenant_rls('discovery_rule_proposal', 'client_id');
-- Explicit GRANT: 0010's default grant loop only covers tables that existed
-- when it ran (the #182/#183 lesson) -- append-only (no UPDATE/DELETE),
-- matching contract_rule_proposal's (0040) own append-only grant.
GRANT SELECT, INSERT ON discovery_rule_proposal TO freight_app;

-- Down Migration
REVOKE ALL ON discovery_rule_proposal FROM freight_app;
DROP TABLE IF EXISTS discovery_rule_proposal;
