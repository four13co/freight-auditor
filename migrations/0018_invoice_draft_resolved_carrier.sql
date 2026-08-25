-- Up Migration
ALTER TABLE invoice_draft
  ADD COLUMN resolved_carrier_id uuid REFERENCES carrier(id);

-- Down Migration
ALTER TABLE invoice_draft DROP COLUMN IF EXISTS resolved_carrier_id;
