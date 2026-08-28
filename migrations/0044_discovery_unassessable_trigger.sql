-- Up Migration
CREATE TABLE discovery_trigger (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid NOT NULL REFERENCES client(id),
 trigger_type text NOT NULL CHECK(trigger_type='UNASSESSABLE_RESULT'), audit_run_id uuid NOT NULL REFERENCES audit_run(id),
 source_kind text NOT NULL CHECK(source_kind IN('VARIANCE_FINDING','GATE_FAILURE')),
 variance_finding_id uuid REFERENCES variance_finding(id), gate_failure_id uuid REFERENCES gate_failure(id),
 criterion_id uuid NOT NULL REFERENCES criterion(id), rule_version_id uuid NOT NULL REFERENCES rule_version(id),
 evaluated_expr_hash char(64) NOT NULL CHECK(evaluated_expr_hash ~ '^[a-f0-9]{64}$'), detail jsonb NOT NULL,
 detected_at timestamptz NOT NULL DEFAULT now(), CHECK((variance_finding_id IS NOT NULL)::int+(gate_failure_id IS NOT NULL)::int=1),
 UNIQUE(client_id,variance_finding_id), UNIQUE(client_id,gate_failure_id)
);
SELECT apply_tenant_rls('discovery_trigger','client_id');
GRANT SELECT,INSERT ON discovery_trigger TO freight_app;
-- Down Migration
REVOKE ALL ON discovery_trigger FROM freight_app; DROP TABLE IF EXISTS discovery_trigger;
