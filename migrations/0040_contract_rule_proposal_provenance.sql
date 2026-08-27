-- Up Migration
-- P3.C.6: immutable proposal evidence. These rows are not active rule versions.
CREATE TABLE contract_rule_proposal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES client(id),
  verified_contract_version_id uuid NOT NULL REFERENCES verified_contract_version(id),
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
  source_document_sha256 char(64) NOT NULL CHECK (source_document_sha256 ~ '^[a-f0-9]{64}$'),
  extraction_response_hash char(64) NOT NULL CHECK (extraction_response_hash ~ '^[a-f0-9]{64}$'),
  verification_hash char(64) NOT NULL CHECK (verification_hash ~ '^[a-f0-9]{64}$'),
  proposal_hash char(64) NOT NULL CHECK (proposal_hash ~ '^[a-f0-9]{64}$'),
  actor_user_id uuid NOT NULL REFERENCES app_user(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, proposal_hash),
  UNIQUE (client_id, verified_contract_version_id, criterion_key, ast_hash)
);
CREATE INDEX contract_rule_proposal_version_idx ON contract_rule_proposal (client_id, verified_contract_version_id, recorded_at);

CREATE TABLE contract_rule_proposal_clause (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES client(id),
  proposal_id uuid NOT NULL REFERENCES contract_rule_proposal(id),
  contract_clause_id uuid NOT NULL REFERENCES contract_clause(id),
  citations jsonb NOT NULL CHECK (jsonb_typeof(citations) = 'array' AND jsonb_array_length(citations) > 0),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, proposal_id, contract_clause_id)
);
CREATE INDEX contract_rule_proposal_clause_idx ON contract_rule_proposal_clause (client_id, contract_clause_id, proposal_id);

SELECT apply_tenant_rls('contract_rule_proposal', 'client_id');
SELECT apply_tenant_rls('contract_rule_proposal_clause', 'client_id');
GRANT SELECT, INSERT ON contract_rule_proposal, contract_rule_proposal_clause TO freight_app;

-- Down Migration
REVOKE ALL ON contract_rule_proposal_clause, contract_rule_proposal FROM freight_app;
DROP TABLE IF EXISTS contract_rule_proposal_clause;
DROP TABLE IF EXISTS contract_rule_proposal;
