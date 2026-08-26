-- Up Migration
ALTER TABLE variance_finding ADD COLUMN evaluated_expr jsonb;
UPDATE variance_finding vf SET evaluated_expr = (SELECT cf.evaluated_expr FROM charge_finding cf
  WHERE cf.audit_run_id = vf.audit_run_id AND cf.criterion_id = vf.criterion_id ORDER BY cf.recorded_at DESC LIMIT 1)
WHERE vf.evaluated_expr IS NULL;
ALTER TABLE variance_finding ADD CONSTRAINT variance_finding_evaluation_required CHECK (evaluated_expr IS NOT NULL) NOT VALID;

-- Down Migration
ALTER TABLE variance_finding DROP CONSTRAINT IF EXISTS variance_finding_evaluation_required;
ALTER TABLE variance_finding DROP COLUMN IF EXISTS evaluated_expr;
