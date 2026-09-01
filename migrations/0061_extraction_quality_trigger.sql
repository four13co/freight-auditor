-- Up Migration
-- P3.D.3: surfaces extraction_field rows that need human attention as
-- discovery triggers -- LOW_CONFIDENCE (the model answered but its stated
-- confidence is below threshold) and STRUCTURAL_ANOMALY (the model could not
-- resolve the field at all: extraction_status IN (NOT_FOUND, AMBIGUOUS), e.g.
-- an ambiguous multi-page rate-table orientation). Distinct from P3.D.4's
-- suspicious_pass_trigger (0054), which covers charges that passed
-- structural validation despite a missing-data gap -- this is contract
-- extraction quality, not invoice-charge coverage.
--
-- ai_value is never SQL NULL (persist-contract-extraction.ts always writes a
-- populated {status,rawText,normalizedValue} envelope), so the split is on
-- extraction_status/confidence, not ai_value nullity.
--
-- New table rather than a row in discovery_trigger (0044), for the same
-- reason 0054/0059 needed one: 0044's criterion_id/rule_version_id/
-- evaluated_expr_hash columns are NOT NULL, all encoding rule-evaluation-time
-- provenance. Extraction runs independent of any audit run/rule evaluation --
-- keyed by source_document_id, not audit_run_id. Widening 0044 would be a
-- non-additive schema edit; this table keeps the edit additive.
CREATE TABLE extraction_quality_trigger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES client(id),
  source_document_id uuid NOT NULL REFERENCES source_document(id),
  extraction_field_id uuid NOT NULL REFERENCES extraction_field(id),
  trigger_type text NOT NULL CHECK (trigger_type IN ('LOW_CONFIDENCE', 'STRUCTURAL_ANOMALY')),
  field_path text NOT NULL,
  confidence numeric(6,4) NOT NULL,
  detail jsonb NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, extraction_field_id, trigger_type)
);
CREATE INDEX extraction_quality_trigger_doc_idx ON extraction_quality_trigger (client_id, source_document_id);
SELECT apply_tenant_rls('extraction_quality_trigger', 'client_id');
-- Explicit GRANT: 0010's default grant loop only covers tables that existed
-- when 0010 ran (the #182/#183 lesson).
GRANT SELECT, INSERT ON extraction_quality_trigger TO freight_app;

-- Down Migration
REVOKE ALL ON extraction_quality_trigger FROM freight_app;
DROP TABLE IF EXISTS extraction_quality_trigger;
