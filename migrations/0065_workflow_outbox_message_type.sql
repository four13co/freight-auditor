-- Up Migration
-- P4.A.6: unique idempotency keys for external effects. workflow_outbox_message
-- (0063/P4.A.5) already gives the *recording* of a delivery intent a unique
-- idempotency key -- UNIQUE (client_id, dedupe_key) -- but "no live caller
-- wired in yet" (that migration's own comment) defers the piece dedupe_key
-- is actually for: a concrete deliverer that dispatches each message to the
-- sender that knows how to perform its particular external effect.
-- workflow_command solved the identical per-row dispatch problem with
-- command_type (0053); this is that same column for the outbox side, so a
-- future concrete sender (an HTTP call to a carrier, a payment provider,
-- etc.) can register against a specific message_type instead of every
-- outbox row funnelling through one undifferentiated path.
--
-- DEFAULT 'unspecified' keeps this purely additive: the column can be added
-- to the existing (still caller-less, so empty in every real environment)
-- table with no backfill step, and recordOutboxMessage's own schema
-- defaults new callers to the same value when they don't pass one, so no
-- existing call site breaks.
ALTER TABLE workflow_outbox_message
  ADD COLUMN message_type text NOT NULL DEFAULT 'unspecified' CHECK (message_type ~ '^[a-z][a-z0-9_]*$');

-- Down Migration
ALTER TABLE workflow_outbox_message DROP COLUMN message_type;
