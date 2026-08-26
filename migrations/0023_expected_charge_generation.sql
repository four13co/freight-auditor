-- Up Migration
-- Deterministic expected-side charge evidence (P2.B.1).
ALTER TABLE expected_charge
  ADD COLUMN idempotency_key text,
  ADD COLUMN source_key text,
  ADD COLUMN calculation jsonb,
  ADD COLUMN clause_id uuid REFERENCES contract_clause(id);

CREATE UNIQUE INDEX expected_charge_generated_dedup_idx
  ON expected_charge (client_id, audit_run_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE expected_charge ADD CONSTRAINT expected_charge_generated_complete
  CHECK (idempotency_key IS NULL OR
    (source_key IS NOT NULL AND calculation IS NOT NULL AND expected_amount IS NOT NULL AND currency IS NOT NULL));

REVOKE UPDATE, DELETE, TRUNCATE ON expected_charge FROM freight_app;
GRANT SELECT, INSERT ON expected_charge TO freight_app;

-- Down Migration
DROP INDEX IF EXISTS expected_charge_generated_dedup_idx;
ALTER TABLE expected_charge DROP CONSTRAINT IF EXISTS expected_charge_generated_complete;
ALTER TABLE expected_charge
  DROP COLUMN IF EXISTS clause_id,
  DROP COLUMN IF EXISTS calculation,
  DROP COLUMN IF EXISTS source_key,
  DROP COLUMN IF EXISTS idempotency_key;
GRANT SELECT, INSERT, UPDATE, DELETE ON expected_charge TO freight_app;
