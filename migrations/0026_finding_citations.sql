-- Up Migration: cell-level rate provenance and direct finding citations.
CREATE TABLE rate_cell (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES client(id),
  contract_rate_id uuid NOT NULL REFERENCES contract_rate(id),
  cell_ref text NOT NULL,
  source_document_id uuid NOT NULL REFERENCES source_document(id),
  clause_id uuid REFERENCES contract_clause(id),
  rate numeric(18,4) NOT NULL,
  currency char(3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_rate_id, cell_ref)
);
CREATE INDEX rate_cell_client_idx ON rate_cell (client_id, contract_rate_id);
GRANT SELECT, INSERT ON rate_cell TO freight_app;

ALTER TABLE expected_charge ADD COLUMN rate_cell_id uuid REFERENCES rate_cell(id), ADD COLUMN source_document_id uuid REFERENCES source_document(id);
ALTER TABLE gate_failure ADD COLUMN clause_id uuid REFERENCES contract_clause(id), ADD COLUMN rate_cell_id uuid REFERENCES rate_cell(id), ADD COLUMN source_document_id uuid REFERENCES source_document(id);
ALTER TABLE charge_finding ADD COLUMN clause_id uuid REFERENCES contract_clause(id), ADD COLUMN rate_cell_id uuid REFERENCES rate_cell(id), ADD COLUMN source_document_id uuid REFERENCES source_document(id);
ALTER TABLE variance_finding ADD COLUMN rate_cell_id uuid REFERENCES rate_cell(id), ADD COLUMN source_document_id uuid REFERENCES source_document(id);

-- Down Migration
ALTER TABLE variance_finding DROP COLUMN IF EXISTS source_document_id, DROP COLUMN IF EXISTS rate_cell_id;
ALTER TABLE charge_finding DROP COLUMN IF EXISTS source_document_id, DROP COLUMN IF EXISTS rate_cell_id, DROP COLUMN IF EXISTS clause_id;
ALTER TABLE gate_failure DROP COLUMN IF EXISTS source_document_id, DROP COLUMN IF EXISTS rate_cell_id, DROP COLUMN IF EXISTS clause_id;
ALTER TABLE expected_charge DROP COLUMN IF EXISTS source_document_id, DROP COLUMN IF EXISTS rate_cell_id;
DROP TABLE IF EXISTS rate_cell;
