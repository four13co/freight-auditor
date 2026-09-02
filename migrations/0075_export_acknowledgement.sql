-- Up Migration
-- P4.B.9 (86e2zfhev): persist the result of each export attempt made through
-- a P4.B.8 (86e2zfhcw, PR #265) ExportAdapter. export-adapter.ts's
-- ExportAdapterRegistry.export() has no caller in src/ yet (no target vendor
-- is chosen -- P4.B.8's own no-gos), so this table has no production writer
-- either; it exists so the persistence contract is testable and ready for
-- whichever future item wires a real vendor call through the registry.
--
-- Append-only (financial evidentiary record, mirrors recovery_event/0008 and
-- workflow_outbox_message/0063's own "persist the outcome" shape) -- no
-- UPDATE/DELETE grant below, matching 0010's append-only idiom.
--
-- Idempotency (86e2zfhev's AC3): a duplicate export attempt for the same
-- (client, system, dedupe key) must not create a second ACKNOWLEDGED row.
-- The unique index is scoped to (client_id, system_code, dedupe_key), not
-- just (client_id, dedupe_key) -- StandInExportAdapter's own idempotency
-- cache is per-adapter-instance and adapters are keyed by systemCode
-- (export-adapter.ts:24-45), so P4.B.8's dedupe contract is per-system. A
-- FAILED attempt is NOT deduped: a retry that fails again is a distinct,
-- legitimate attempt worth its own row (mirrors recovery_event's "a genuine
-- second event is not a duplicate of the first" reasoning), so only
-- ACKNOWLEDGED rows are covered by the unique index.
CREATE TABLE export_acknowledgement (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                 uuid NOT NULL REFERENCES client(id),
  claim_id                  uuid REFERENCES claim(id),
  payment_gate_decision_id  uuid REFERENCES payment_gate_decision(id),
  system_code               text NOT NULL,
  adapter_version           text NOT NULL,
  dedupe_key                text NOT NULL,
  status                    text NOT NULL CHECK (status IN ('ACKNOWLEDGED', 'FAILED')),
  external_reference        text,
  reason                    text,
  recorded_at               timestamptz NOT NULL DEFAULT now(),
  -- Every reconciliation record must trace to the payment/claim it exported
  -- (86e2zfhev's Solution: "linking: the originating payment/claim record").
  CONSTRAINT export_acknowledgement_has_origin_chk
    CHECK (claim_id IS NOT NULL OR payment_gate_decision_id IS NOT NULL),
  -- Status/field coherence, enforced where it can't drift (mirrors 0060's
  -- and 0074's CHECK-at-the-column-boundary pattern): an ACKNOWLEDGED row
  -- always carries its externalReference and never a reason; a FAILED row
  -- is the exact inverse.
  CONSTRAINT export_acknowledgement_status_fields_chk
    CHECK (
      (status = 'ACKNOWLEDGED' AND external_reference IS NOT NULL AND reason IS NULL)
      OR (status = 'FAILED' AND reason IS NOT NULL AND external_reference IS NULL)
    )
);

CREATE INDEX export_acknowledgement_claim_idx ON export_acknowledgement (client_id, claim_id);
CREATE INDEX export_acknowledgement_payment_idx ON export_acknowledgement (client_id, payment_gate_decision_id);

-- Partial unique index backing the idempotency contract above; only
-- ACKNOWLEDGED rows participate.
CREATE UNIQUE INDEX export_acknowledgement_ack_dedupe_idx
  ON export_acknowledgement (client_id, system_code, dedupe_key)
  WHERE status = 'ACKNOWLEDGED';

SELECT apply_tenant_rls('export_acknowledgement', 'client_id');

GRANT SELECT, INSERT ON export_acknowledgement TO freight_app;

-- Down Migration
REVOKE ALL ON export_acknowledgement FROM freight_app;
DROP TABLE IF EXISTS export_acknowledgement;
