-- Up Migration
-- ---------------------------------------------------------------------------
-- 0008: findings, the four outputs, extraction provenance, and the universal
-- append-only ledger (Master Spec §6.7, §6.8, §6.9).
--
-- The defensibility chain (§1.8, §8): every finding cites
--   finding → criterion → rule_version → clause (or human_override) → source doc
-- and — via variance_finding.transport_document_id — resolves to the transport
-- evidence too. gate failures route to the carrier; variances to the analyst.
-- ---------------------------------------------------------------------------

-- Gate failures (§6.7): one per failed GATING criterion → carrier kickback.
-- Append-only. Never enters disputes.
CREATE TABLE gate_failure (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      uuid NOT NULL REFERENCES client(id),
  audit_run_id   uuid NOT NULL REFERENCES audit_run(id),
  criterion_id   uuid REFERENCES criterion(id),
  rule_version_id uuid REFERENCES rule_version(id),
  defect         text NOT NULL,
  citation       text,                            -- clause/standard cited to the carrier
  evaluated_expr jsonb,                            -- the failing AST sub-expr (explanation)
  recorded_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gate_failure_run_idx ON gate_failure (client_id, audit_run_id);

-- Scoring observations (§6.7): one per SCORING criterion. Append-only.
CREATE TABLE charge_finding (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         uuid NOT NULL REFERENCES client(id),
  audit_run_id      uuid NOT NULL REFERENCES audit_run(id),
  criterion_id      uuid REFERENCES criterion(id),
  rule_version_id   uuid REFERENCES rule_version(id),
  charge_fact_id    uuid REFERENCES charge_fact(id),
  result            charge_finding_result NOT NULL,
  variance_amount   numeric(18,4),
  variance_direction variance_direction,
  currency          char(3),
  coverage_hardness rule_hardness,               -- which tier produced the verdict
  evaluated_expr    jsonb,                         -- the evaluated AST = the explanation
  recorded_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX charge_finding_run_idx ON charge_finding (client_id, audit_run_id);

-- The deliberate non-1:1 bridge (§6.7): variance on group totals.
CREATE TABLE charge_alignment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL REFERENCES client(id),
  audit_run_id uuid NOT NULL REFERENCES audit_run(id),
  label        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE charge_alignment_member (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alignment_id   uuid NOT NULL REFERENCES charge_alignment(id),
  charge_fact_id uuid REFERENCES charge_fact(id),
  expected_charge_id uuid REFERENCES expected_charge(id)
);
CREATE INDEX charge_alignment_member_idx ON charge_alignment_member (alignment_id);

-- The actionable rollup (§6.7). Cites criterion → rule_version → clause AND the
-- transport-document evidence — the full defensibility chain in one row.
CREATE TABLE variance_finding (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id            uuid NOT NULL REFERENCES client(id),
  audit_run_id         uuid NOT NULL REFERENCES audit_run(id),
  criterion_id         uuid REFERENCES criterion(id),
  rule_version_id      uuid REFERENCES rule_version(id),
  clause_id            uuid REFERENCES contract_clause(id),      -- clause-level attribution
  transport_document_id uuid REFERENCES transport_document(id),  -- evidence bridge (§1.8)
  charge_fact_id       uuid REFERENCES charge_fact(id),
  classification       text,
  direction            variance_direction,
  materiality          numeric(18,4),
  variance_amount      numeric(18,4),
  currency             char(3),
  status               variance_status NOT NULL DEFAULT 'open',
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX variance_finding_client_status_idx ON variance_finding (client_id, status);
CREATE INDEX variance_finding_run_idx ON variance_finding (client_id, audit_run_id);

-- Per-run scorecard rollup (§6.7). Mutable summary (not a financial-boundary row).
CREATE TABLE scorecard (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          uuid NOT NULL REFERENCES client(id),
  audit_run_id       uuid NOT NULL UNIQUE REFERENCES audit_run(id),
  conformed_count    integer NOT NULL DEFAULT 0,
  variance_count     integer NOT NULL DEFAULT 0,
  unassessable_count integer NOT NULL DEFAULT 0,
  total_overcharge   numeric(18,4) NOT NULL DEFAULT 0,
  total_undercharge  numeric(18,4) NOT NULL DEFAULT 0,
  currency           char(3),
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Finding lifecycle events (§6.7). Append-only.
CREATE TABLE finding_status_event (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid NOT NULL REFERENCES client(id),
  variance_finding_id uuid NOT NULL REFERENCES variance_finding(id),
  from_status         variance_status,
  to_status           variance_status NOT NULL,
  actor_kind          actor_kind NOT NULL,
  note                text,
  recorded_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX finding_status_event_finding_idx ON finding_status_event (client_id, variance_finding_id, recorded_at DESC);

-- ---- The four outputs (§6.8) ----------------------------------------------

CREATE TABLE dispute (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES client(id),
  carrier_id  uuid REFERENCES carrier(id),
  status      dispute_status NOT NULL DEFAULT 'draft',
  amount_claimed numeric(18,4),
  currency    char(3),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dispute_client_status_idx ON dispute (client_id, status);

CREATE TABLE dispute_line (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid NOT NULL REFERENCES client(id),
  dispute_id          uuid NOT NULL REFERENCES dispute(id),
  variance_finding_id uuid REFERENCES variance_finding(id),
  amount              numeric(18,4),
  currency            char(3)
);
CREATE INDEX dispute_line_dispute_idx ON dispute_line (client_id, dispute_id);

-- dispute_comm: append-only communications log.
CREATE TABLE dispute_comm (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES client(id),
  dispute_id  uuid NOT NULL REFERENCES dispute(id),
  direction   text NOT NULL,                       -- outbound|inbound
  body        text,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dispute_comm_dispute_idx ON dispute_comm (client_id, dispute_id, recorded_at DESC);

-- payment_gate_decision: append-only. Reads both outcomes (§6.8).
CREATE TABLE payment_gate_decision (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL REFERENCES client(id),
  invoice_id   uuid NOT NULL REFERENCES invoice(id),
  audit_run_id uuid REFERENCES audit_run(id),
  action       payment_gate_action NOT NULL,
  amount       numeric(18,4),
  currency     char(3),
  actor_kind   actor_kind NOT NULL,
  rationale    text,
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_gate_decision_invoice_idx ON payment_gate_decision (client_id, invoice_id, recorded_at DESC);

CREATE TABLE claim (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      uuid NOT NULL REFERENCES client(id),
  dispute_id     uuid REFERENCES dispute(id),
  amount_claimed numeric(18,4) NOT NULL,
  currency       char(3),
  status         text NOT NULL DEFAULT 'open',
  opened_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX claim_client_idx ON claim (client_id, status);

-- recovery_event: append-only. Every recovered dollar traces to a finding (§6.8).
CREATE TABLE recovery_event (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid NOT NULL REFERENCES client(id),
  claim_id            uuid REFERENCES claim(id),
  variance_finding_id uuid REFERENCES variance_finding(id),
  amount_recovered    numeric(18,4) NOT NULL,
  currency            char(3),
  recorded_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recovery_event_claim_idx ON recovery_event (client_id, claim_id);

-- ---- Extraction provenance (§6.9) -----------------------------------------

-- Keeps the AI's value AND the human correction; confidence, page/bbox, model+prompt.
CREATE TABLE extraction_field (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid NOT NULL REFERENCES client(id),
  source_document_id  uuid REFERENCES source_document(id),
  field_path          text NOT NULL,
  ai_value            jsonb,
  human_value         jsonb,
  confidence          numeric(6,4),
  page_ref            text,
  bbox                jsonb,
  model_version       text,
  prompt_version      text,
  recorded_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX extraction_field_doc_idx ON extraction_field (client_id, source_document_id);

CREATE TABLE clarifying_question (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          uuid NOT NULL REFERENCES client(id),
  source_document_id uuid REFERENCES source_document(id),
  question           text NOT NULL,
  answer             text,
  answer_source      answer_source,                -- keeps analyst knowledge out of few-shot
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX clarifying_question_doc_idx ON clarifying_question (client_id, source_document_id);

-- ---- The universal append-only ledger (§6.9) ------------------------------

CREATE TABLE audit_event (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          uuid REFERENCES client(id),   -- NULL for system-global events
  entity             text NOT NULL,
  entity_id          uuid,
  event              text NOT NULL,
  actor_kind         actor_kind NOT NULL,
  actor_user_id      uuid REFERENCES app_user(id),
  rule_version_id    uuid REFERENCES rule_version(id),
  rubric_snapshot_id uuid REFERENCES rubric_snapshot(id),
  detail             jsonb,
  recorded_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_event_client_entity_idx ON audit_event (client_id, entity, entity_id);
CREATE INDEX audit_event_recorded_idx ON audit_event (recorded_at DESC);

-- Down Migration
DROP TABLE IF EXISTS audit_event;
DROP TABLE IF EXISTS clarifying_question;
DROP TABLE IF EXISTS extraction_field;
DROP TABLE IF EXISTS recovery_event;
DROP TABLE IF EXISTS claim;
DROP TABLE IF EXISTS payment_gate_decision;
DROP TABLE IF EXISTS dispute_comm;
DROP TABLE IF EXISTS dispute_line;
DROP TABLE IF EXISTS dispute;
DROP TABLE IF EXISTS finding_status_event;
DROP TABLE IF EXISTS scorecard;
DROP TABLE IF EXISTS variance_finding;
DROP TABLE IF EXISTS charge_alignment_member;
DROP TABLE IF EXISTS charge_alignment;
DROP TABLE IF EXISTS charge_finding;
DROP TABLE IF EXISTS gate_failure;
