-- Up Migration
ALTER TABLE charge_alignment
  ADD COLUMN level text,
  ADD COLUMN attribution_key text,
  ADD COLUMN currency char(3),
  ADD COLUMN billed_total numeric(18,4),
  ADD COLUMN expected_total numeric(18,4),
  ADD COLUMN variance_amount numeric(18,4),
  ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX charge_alignment_dedup_idx ON charge_alignment (client_id, audit_run_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE charge_alignment_member ADD COLUMN client_id uuid REFERENCES client(id);
UPDATE charge_alignment_member m SET client_id = a.client_id FROM charge_alignment a WHERE a.id = m.alignment_id;
ALTER TABLE charge_alignment_member ALTER COLUMN client_id SET NOT NULL;
ALTER TABLE charge_alignment_member ADD CONSTRAINT charge_alignment_member_one_side
  CHECK ((charge_fact_id IS NOT NULL)::integer + (expected_charge_id IS NOT NULL)::integer = 1);
CREATE UNIQUE INDEX charge_alignment_member_fact_idx ON charge_alignment_member (alignment_id, charge_fact_id) WHERE charge_fact_id IS NOT NULL;
CREATE UNIQUE INDEX charge_alignment_member_expected_idx ON charge_alignment_member (alignment_id, expected_charge_id) WHERE expected_charge_id IS NOT NULL;

ALTER TABLE charge_alignment_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE charge_alignment_member FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_charge_alignment_member ON charge_alignment_member
  USING (client_id = current_setting('app.client_id', true)::uuid)
  WITH CHECK (client_id = current_setting('app.client_id', true)::uuid);
REVOKE UPDATE, DELETE, TRUNCATE ON charge_alignment, charge_alignment_member FROM freight_app;
GRANT SELECT, INSERT ON charge_alignment, charge_alignment_member TO freight_app;

-- Down Migration
DROP POLICY IF EXISTS tenant_isolation_charge_alignment_member ON charge_alignment_member;
DROP INDEX IF EXISTS charge_alignment_member_expected_idx;
DROP INDEX IF EXISTS charge_alignment_member_fact_idx;
ALTER TABLE charge_alignment_member DROP CONSTRAINT IF EXISTS charge_alignment_member_one_side;
ALTER TABLE charge_alignment_member DROP COLUMN IF EXISTS client_id;
DROP INDEX IF EXISTS charge_alignment_dedup_idx;
ALTER TABLE charge_alignment DROP COLUMN IF EXISTS idempotency_key, DROP COLUMN IF EXISTS variance_amount,
  DROP COLUMN IF EXISTS expected_total, DROP COLUMN IF EXISTS billed_total, DROP COLUMN IF EXISTS currency,
  DROP COLUMN IF EXISTS attribution_key, DROP COLUMN IF EXISTS level;
GRANT SELECT, INSERT, UPDATE, DELETE ON charge_alignment, charge_alignment_member TO freight_app;
