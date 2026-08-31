-- Up Migration
-- P3.D.4: surfaces coverage_marker (0019) rows -- "suspicious-pass" gaps on
-- charges that otherwise passed structural validation, plus "missing-data"
-- gaps (INCOMPLETE_RATE_BASIS, FUEL_WITHOUT_RATE_BASIS,
-- MISSING_CHARGE_IDENTITY, see evaluator/fact-bundle.ts's findCoverageMarkers)
-- -- as discovery triggers.
--
-- This is a new table rather than a row in discovery_trigger (0044), for the
-- identical reason PR #192's unknown_charge_code_trigger (0048) needed one:
-- 0044's criterion_id/rule_version_id/evaluated_expr_hash columns are NOT
-- NULL with an exactly-one-of-two source CHECK, all encoding
-- rule-evaluation-time provenance. A coverage_marker is detected during fact
-- resolution, before any rule evaluates -- it has no criterion_id,
-- rule_version_id, or evaluated_expr to point at. Widening 0044's
-- constraints would be a non-additive schema edit; this table keeps the
-- edit additive.
CREATE TABLE suspicious_pass_trigger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES client(id),
  audit_run_id uuid NOT NULL REFERENCES audit_run(id),
  coverage_marker_id uuid NOT NULL REFERENCES coverage_marker(id),
  marker_code text NOT NULL,
  detail jsonb NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, coverage_marker_id)
);
SELECT apply_tenant_rls('suspicious_pass_trigger', 'client_id');
-- Explicit GRANT: 0010's default grant loop only covers tables that existed
-- when it ran (the #182/#183 lesson) -- append-only (no UPDATE/DELETE),
-- matching coverage_marker's (0019) own append-only grant.
GRANT SELECT, INSERT ON suspicious_pass_trigger TO freight_app;

-- Down Migration
REVOKE ALL ON suspicious_pass_trigger FROM freight_app;
DROP TABLE IF EXISTS suspicious_pass_trigger;
