-- Up Migration
-- P3.D.2: detect an unknown/unresolved charge code (charge_fact.category IS
-- NULL -- the persisted signal for a crosswalk-resolution failure, see
-- src/modules/evaluator/persist.ts) as a discovery trigger.
--
-- This is a new table rather than a row in discovery_trigger (0044) because
-- an unknown charge code is detected at ingest time, before any rule
-- evaluation runs: it has no criterion_id/rule_version_id/evaluated_expr to
-- point at, and 0044's criterion_id/rule_version_id/evaluated_expr_hash
-- columns are NOT NULL with an exactly-one-of-two source CHECK, all
-- encoding rule-evaluation-time provenance. Widening those constraints
-- would require dropping three unnamed inline constraints from 0044, which
-- is a non-additive schema edit -- this table keeps the edit additive.
CREATE TABLE unknown_charge_code_trigger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES client(id),
  audit_run_id uuid NOT NULL REFERENCES audit_run(id),
  charge_fact_id uuid NOT NULL REFERENCES charge_fact(id),
  source_code text,
  x12_element text,
  detail jsonb NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, charge_fact_id)
);
SELECT apply_tenant_rls('unknown_charge_code_trigger', 'client_id');
-- Explicit GRANT: 0010's default grant loop only covers tables that existed
-- when 0010 ran (the #182/#183 lesson).
GRANT SELECT, INSERT ON unknown_charge_code_trigger TO freight_app;

-- Down Migration
REVOKE ALL ON unknown_charge_code_trigger FROM freight_app;
DROP TABLE IF EXISTS unknown_charge_code_trigger;
