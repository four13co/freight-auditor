-- Up Migration
-- P4.C.8: dispute_comm (0008) was created as an append-only communications
-- log but has never had a writer -- no application code references it
-- (confirmed by grep at the start of this task). Recording into it
-- idempotently needs the same shape workflow_outbox_message (0063) already
-- uses: a caller-derived dedupe_key plus a UNIQUE(client_id, dedupe_key)
-- constraint, so a handler re-run after a crash (before its own transaction
-- committed the first time) gets the existing row back via
-- ON CONFLICT ... DO NOTHING rather than a second, duplicate communication.
--
-- Table is empty in every environment (no writer has ever existed), so
-- adding a NOT NULL column needs no default/backfill step.
ALTER TABLE dispute_comm ADD COLUMN dedupe_key text NOT NULL;
ALTER TABLE dispute_comm ADD CONSTRAINT dispute_comm_client_dedupe_key_unique UNIQUE (client_id, dedupe_key);

-- Down Migration
ALTER TABLE dispute_comm DROP CONSTRAINT IF EXISTS dispute_comm_client_dedupe_key_unique;
ALTER TABLE dispute_comm DROP COLUMN IF EXISTS dedupe_key;
