-- Up Migration
ALTER TABLE variance_finding ADD COLUMN alignment_id uuid REFERENCES charge_alignment(id);
CREATE INDEX variance_finding_alignment_idx ON variance_finding (client_id, alignment_id) WHERE alignment_id IS NOT NULL;

-- Down Migration
DROP INDEX IF EXISTS variance_finding_alignment_idx;
ALTER TABLE variance_finding DROP COLUMN IF EXISTS alignment_id;
