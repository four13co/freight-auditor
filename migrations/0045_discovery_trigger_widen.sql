-- Up Migration
-- Widen discovery_trigger (0044) to accept three more independently-detected
-- trigger types, each sourced from evidence that already exists elsewhere in
-- the ledger:
--   UNKNOWN_CHARGE_CODE          <- charge_fact (category IS NULL)
--   LOW_CONFIDENCE               <- extraction_field (confidence below threshold)
--   STRUCTURAL_ANOMALY           <- extraction_field (ai_value IS NULL: model abstained)
--   SUSPICIOUS_PASS_MISSING_DATA <- coverage_marker (already the durable
--                                   "suspicious-pass gap" evidence, per 0019)
-- criterion_id/rule_version_id/audit_run_id are only meaningful for a trigger
-- that originates from a rule evaluation against an audit_run
-- (UNASSESSABLE_RESULT); extraction_field-sourced triggers key off
-- source_document_id instead, which has no audit_run at all. All three
-- columns go nullable and type-conditional CHECKs keep 0044's original
-- guarantee intact (every UNASSESSABLE_RESULT trigger still pins
-- audit_run_id/criterion_id/rule_version_id) instead of silently dropping it.
ALTER TABLE discovery_trigger DROP CONSTRAINT discovery_trigger_trigger_type_check;
ALTER TABLE discovery_trigger ADD CONSTRAINT discovery_trigger_trigger_type_check
  CHECK (trigger_type IN (
    'UNASSESSABLE_RESULT','UNKNOWN_CHARGE_CODE','LOW_CONFIDENCE',
    'STRUCTURAL_ANOMALY','SUSPICIOUS_PASS_MISSING_DATA'
  ));

ALTER TABLE discovery_trigger ALTER COLUMN audit_run_id DROP NOT NULL;
ALTER TABLE discovery_trigger ALTER COLUMN criterion_id DROP NOT NULL;
ALTER TABLE discovery_trigger ALTER COLUMN rule_version_id DROP NOT NULL;
ALTER TABLE discovery_trigger ADD CONSTRAINT discovery_trigger_rule_fields_check
  CHECK (trigger_type <> 'UNASSESSABLE_RESULT'
         OR (audit_run_id IS NOT NULL AND criterion_id IS NOT NULL AND rule_version_id IS NOT NULL));

ALTER TABLE discovery_trigger ADD COLUMN charge_fact_id uuid REFERENCES charge_fact(id);
ALTER TABLE discovery_trigger ADD COLUMN extraction_field_id uuid REFERENCES extraction_field(id);
ALTER TABLE discovery_trigger ADD COLUMN coverage_marker_id uuid REFERENCES coverage_marker(id);
ALTER TABLE discovery_trigger ADD COLUMN source_document_id uuid REFERENCES source_document(id);

ALTER TABLE discovery_trigger DROP CONSTRAINT discovery_trigger_check;
ALTER TABLE discovery_trigger ADD CONSTRAINT discovery_trigger_one_source_check
  CHECK (
    (variance_finding_id IS NOT NULL)::int + (gate_failure_id IS NOT NULL)::int +
    (charge_fact_id IS NOT NULL)::int + (extraction_field_id IS NOT NULL)::int +
    (coverage_marker_id IS NOT NULL)::int = 1
  );

-- extraction_field-sourced triggers (LOW_CONFIDENCE, STRUCTURAL_ANOMALY) pin
-- the document they came from since they have no audit_run_id to anchor on.
ALTER TABLE discovery_trigger ADD CONSTRAINT discovery_trigger_extraction_source_doc_check
  CHECK (extraction_field_id IS NULL OR source_document_id IS NOT NULL);

ALTER TABLE discovery_trigger ALTER COLUMN source_kind DROP NOT NULL;
ALTER TABLE discovery_trigger DROP CONSTRAINT discovery_trigger_source_kind_check;
ALTER TABLE discovery_trigger ADD CONSTRAINT discovery_trigger_source_kind_check
  CHECK (source_kind IN (
    'VARIANCE_FINDING','GATE_FAILURE','CHARGE_FACT','EXTRACTION_FIELD','COVERAGE_MARKER'
  ));

ALTER TABLE discovery_trigger ADD CONSTRAINT discovery_trigger_charge_fact_uk UNIQUE (client_id, charge_fact_id);
ALTER TABLE discovery_trigger ADD CONSTRAINT discovery_trigger_extraction_field_uk UNIQUE (client_id, extraction_field_id, trigger_type);
ALTER TABLE discovery_trigger ADD CONSTRAINT discovery_trigger_coverage_marker_uk UNIQUE (client_id, coverage_marker_id);

-- Down Migration
ALTER TABLE discovery_trigger DROP CONSTRAINT discovery_trigger_coverage_marker_uk;
ALTER TABLE discovery_trigger DROP CONSTRAINT discovery_trigger_extraction_field_uk;
ALTER TABLE discovery_trigger DROP CONSTRAINT discovery_trigger_charge_fact_uk;
ALTER TABLE discovery_trigger DROP CONSTRAINT discovery_trigger_source_kind_check;
ALTER TABLE discovery_trigger ADD CONSTRAINT discovery_trigger_source_kind_check
  CHECK (source_kind IN ('VARIANCE_FINDING','GATE_FAILURE'));
ALTER TABLE discovery_trigger ALTER COLUMN source_kind SET NOT NULL;
ALTER TABLE discovery_trigger DROP CONSTRAINT discovery_trigger_extraction_source_doc_check;
ALTER TABLE discovery_trigger DROP CONSTRAINT discovery_trigger_one_source_check;
ALTER TABLE discovery_trigger ADD CONSTRAINT discovery_trigger_check
  CHECK ((variance_finding_id IS NOT NULL)::int + (gate_failure_id IS NOT NULL)::int = 1);
ALTER TABLE discovery_trigger DROP COLUMN source_document_id;
ALTER TABLE discovery_trigger DROP COLUMN coverage_marker_id;
ALTER TABLE discovery_trigger DROP COLUMN extraction_field_id;
ALTER TABLE discovery_trigger DROP COLUMN charge_fact_id;
ALTER TABLE discovery_trigger DROP CONSTRAINT discovery_trigger_rule_fields_check;
ALTER TABLE discovery_trigger ALTER COLUMN rule_version_id SET NOT NULL;
ALTER TABLE discovery_trigger ALTER COLUMN criterion_id SET NOT NULL;
ALTER TABLE discovery_trigger ALTER COLUMN audit_run_id SET NOT NULL;
ALTER TABLE discovery_trigger DROP CONSTRAINT discovery_trigger_trigger_type_check;
ALTER TABLE discovery_trigger ADD CONSTRAINT discovery_trigger_trigger_type_check
  CHECK (trigger_type = 'UNASSESSABLE_RESULT');
