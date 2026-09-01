-- Up Migration
-- P5.C.5: asynchronous reconciliation exports. getPortfolioReconciliation
-- (P5.C.4, merged) computes a tenant's full claim/recovery-event reconciliation
-- synchronously today; as claim/recovery-event volume grows that scan becomes
-- too expensive to run inline in a request, which is exactly the AC this table
-- exists to satisfy ("High-volume paths are paginated or asynchronous").
--
-- Mirrors workflow_outbox_message's (0063) "persist the intent, a separate
-- scan+claim+process step does the work" shape rather than wiring pg-boss
-- into the API server (src/server/index.ts starts no job worker today, and
-- no route anywhere in this repo calls boss.send directly -- every existing
-- enqueue happens from inside a worker-side scan handler). A request just
-- inserts a 'pending' row here; SCAN_RECONCILIATION_EXPORTS_V1 (running in
-- the existing worker process) claims it and dispatches EXPORT_RECONCILIATION_V1
-- to do the actual computation, same two-step boundary as workflow_command
-- (P4.A.3) and workflow_outbox_message (P4.A.5) both shipped with.
CREATE TABLE reconciliation_export (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid NOT NULL REFERENCES client(id),
  idempotency_key  text NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'completed', 'failed')),
  result           jsonb,
  error            text,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  -- Idempotent request: a caller retrying the same request (same derived
  -- idempotency_key) after a crash gets the existing row back rather than a
  -- second export.
  UNIQUE (client_id, idempotency_key)
);

-- Due-row scan, mirroring workflow_outbox_message_due_idx's shape: pending
-- rows only, tenant-scoped, cheap as completed/failed rows accumulate.
CREATE INDEX reconciliation_export_due_idx ON reconciliation_export (client_id, requested_at)
  WHERE status = 'pending';

SELECT apply_tenant_rls('reconciliation_export', 'client_id');

-- Mutable (status/result/error/completed_at advance as the scan claims and
-- the export job completes or fails it), matching workflow_outbox_message's
-- own grant shape -- no DELETE granted: nothing in this task's boundary ever
-- removes a row.
GRANT SELECT, INSERT, UPDATE ON reconciliation_export TO freight_app;

-- Down Migration
REVOKE ALL ON reconciliation_export FROM freight_app;
DROP TABLE IF EXISTS reconciliation_export;
