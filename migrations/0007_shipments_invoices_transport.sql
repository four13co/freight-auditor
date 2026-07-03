-- Up Migration
-- ---------------------------------------------------------------------------
-- 0007: shipments, invoices, canonical charges, transport-document evidence,
-- and the audit run / recompute trace (Master Spec §6.5, §6.6).
--
-- TRANSPORT DOCUMENT — jsonb-vs-normalized decision:
-- The TransportDocument JSON Schema (14 nested entities: parties, legs, units,
-- cargo lines, DG, charges, ...) is EVIDENCE we cite, not the operational spine.
-- We store the full extracted structure as `document jsonb` PLUS typed
-- projection columns for the handful of fields that need indexing, FKs, and
-- clause-level citation (document_number, document_type, transport_mode,
-- parent_document_number). Rationale:
--   * The extraction shape is wide, sparse, mode-variant, and evolves with the
--     extractor — normalizing all 14 entities now = 14+ churny tables for data
--     we mostly read as a whole document. jsonb keeps the evidence faithful and
--     lossless while the projections give us the query/citation handles we need.
--   * Citations resolve to the document + a jsonb path (bbox/field), which is
--     exactly what the defensibility chain (§1.8) requires — no need to shred
--     every cargo line into rows to cite one.
--   * If a specific projection (e.g. container numbers) later needs heavy
--     relational querying, promote just that entity to its own table
--     additively — the jsonb stays as the source of truth.
-- ---------------------------------------------------------------------------

-- Transport documents = cited evidence (from PDF/BL/AWB extraction).
CREATE TABLE transport_document (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id              uuid NOT NULL REFERENCES client(id),
  source_document_id     uuid REFERENCES source_document(id),   -- immutable PDF bytes
  document_number        text NOT NULL,                          -- projection (indexed)
  document_type          transport_doc_type NOT NULL,            -- projection
  transport_mode         transport_mode NOT NULL,                -- projection
  parent_document_number text,                                   -- projection (MBL/MAWB rollup)
  document               jsonb NOT NULL,                         -- full extracted structure
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transport_document_client_idx ON transport_document (client_id, document_number);
CREATE INDEX transport_document_parent_idx ON transport_document (client_id, parent_document_number)
  WHERE parent_document_number IS NOT NULL;
CREATE INDEX transport_document_gin ON transport_document USING gin (document jsonb_path_ops);

-- Shipment: ship_date is THE temporal-resolution key (§1.6). contract_version
-- is resolved + pinned at ingest.
CREATE TABLE shipment (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid NOT NULL REFERENCES client(id),
  carrier_id          uuid REFERENCES carrier(id),
  contract_version_id uuid REFERENCES contract_version(id),      -- resolved + pinned
  transport_document_id uuid REFERENCES transport_document(id),  -- bridge to evidence
  ship_date           date NOT NULL,
  reference           text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shipment_client_shipdate_idx ON shipment (client_id, ship_date);

-- Immutable raw EDI (§6.5, §6.9). sha256-addressed.
CREATE TABLE raw_edi_document (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL REFERENCES client(id),
  sha256       char(64) NOT NULL,
  transaction_set transaction_set,
  storage_uri  text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sha256)
);

CREATE TABLE invoice (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          uuid NOT NULL REFERENCES client(id),
  shipment_id        uuid REFERENCES shipment(id),
  carrier_id         uuid REFERENCES carrier(id),
  raw_edi_document_id uuid REFERENCES raw_edi_document(id),
  transaction_set    transaction_set NOT NULL,                  -- '210' | '310'
  invoice_number     text,
  currency           char(3),
  parser_version     text NOT NULL,                             -- pinned for reproducibility
  status             text NOT NULL DEFAULT 'ingested',
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_client_idx ON invoice (client_id, transaction_set);

-- charge_fact = the billed side (§6.5). Canonical model; category via crosswalk,
-- never the raw EDI element. Money is numeric(18,4) + per-charge currency.
CREATE TABLE charge_fact (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid NOT NULL REFERENCES client(id),
  invoice_id      uuid NOT NULL REFERENCES invoice(id),
  code            text,                                        -- raw carrier code
  x12_element     text,                                        -- source element (e.g. L108)
  category        text,                                        -- canonical, via crosswalk
  amount          numeric(18,4) NOT NULL,
  currency        char(3) NOT NULL,                            -- never pre-converted (§6)
  basis           numeric(18,4),
  rate            numeric(18,4),
  raw_description text,
  source_loop     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX charge_fact_client_invoice_idx ON charge_fact (client_id, invoice_id);
CREATE INDEX charge_fact_category_idx ON charge_fact (client_id, category);

-- Audit run + recompute trace (§6.6). audit_run pins the snapshot + engine spec
-- so a finding replays byte-identically.
CREATE TABLE audit_run (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          uuid NOT NULL REFERENCES client(id),
  invoice_id         uuid NOT NULL REFERENCES invoice(id),
  rubric_snapshot_id uuid REFERENCES rubric_snapshot(id),
  engine_spec_version text NOT NULL,
  outcome            audit_outcome NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_run_client_invoice_idx ON audit_run (client_id, invoice_id);

-- backtest_run_id soft ref from promotion_event → audit_run (declared in 0006).
ALTER TABLE promotion_event
  ADD CONSTRAINT promotion_event_backtest_fk
  FOREIGN KEY (backtest_run_id) REFERENCES audit_run(id);

CREATE TABLE expected_charge (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES client(id),
  audit_run_id  uuid NOT NULL REFERENCES audit_run(id),
  charge_fact_id uuid REFERENCES charge_fact(id),
  category      text,
  expected_amount numeric(18,4),
  currency      char(3),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX expected_charge_run_idx ON expected_charge (client_id, audit_run_id);

-- computation_trace: append-only ordered steps + pinned inputs + clause cite (§6.6).
CREATE TABLE computation_trace (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES client(id),
  audit_run_id  uuid NOT NULL REFERENCES audit_run(id),
  step_order    integer NOT NULL,
  step          jsonb NOT NULL,
  pinned_inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  clause_id     uuid REFERENCES contract_clause(id),
  recorded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX computation_trace_run_idx ON computation_trace (client_id, audit_run_id, step_order);

-- Down Migration
ALTER TABLE promotion_event DROP CONSTRAINT IF EXISTS promotion_event_backtest_fk;
DROP TABLE IF EXISTS computation_trace;
DROP TABLE IF EXISTS expected_charge;
DROP TABLE IF EXISTS audit_run;
DROP TABLE IF EXISTS charge_fact;
DROP TABLE IF EXISTS invoice;
DROP TABLE IF EXISTS raw_edi_document;
DROP TABLE IF EXISTS shipment;
DROP TABLE IF EXISTS transport_document;
