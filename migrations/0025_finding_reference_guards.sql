-- Up Migration: preserve legacy rows while rejecting all new uncited findings.
ALTER TABLE gate_failure ADD CONSTRAINT gate_failure_refs_required
  CHECK (criterion_id IS NOT NULL AND rule_version_id IS NOT NULL) NOT VALID;
ALTER TABLE charge_finding ADD CONSTRAINT charge_finding_refs_required
  CHECK (criterion_id IS NOT NULL AND rule_version_id IS NOT NULL) NOT VALID;
ALTER TABLE variance_finding ADD CONSTRAINT variance_finding_refs_required
  CHECK (criterion_id IS NOT NULL AND rule_version_id IS NOT NULL) NOT VALID;

-- Down Migration
ALTER TABLE variance_finding DROP CONSTRAINT IF EXISTS variance_finding_refs_required;
ALTER TABLE charge_finding DROP CONSTRAINT IF EXISTS charge_finding_refs_required;
ALTER TABLE gate_failure DROP CONSTRAINT IF EXISTS gate_failure_refs_required;
