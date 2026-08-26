-- Up Migration
ALTER TABLE gate_failure ADD COLUMN transport_document_id uuid REFERENCES transport_document(id);
ALTER TABLE charge_finding ADD COLUMN transport_document_id uuid REFERENCES transport_document(id);

-- Down Migration
ALTER TABLE charge_finding DROP COLUMN IF EXISTS transport_document_id;
ALTER TABLE gate_failure DROP COLUMN IF EXISTS transport_document_id;
