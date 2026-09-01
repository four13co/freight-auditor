-- Up Migration
-- P4.A.5: the transactional-outbox primitive workflow_command consumes but
-- doesn't provide (0053's own header comment names this table's job: "it is
-- not transactional outbox delivery (P4.A.5) -- those consume this table,
-- they are not built here").
--
-- The gap this closes: run-workflow-command-handler.ts's handler runs
-- inside the caller's DB transaction, so a plain DB write a handler makes is
-- already transactional with completeWorkflowCommand. An external side
-- effect (an HTTP call to a carrier, a payment provider, etc.) is NOT --
-- it isn't rolled back by a DB rollback, so a handler that calls out
-- directly and then crashes before commit gets retried and calls out AGAIN,
-- duplicating the external effect (exactly the gap run-workflow-command-
-- handler.ts's own docstring names and defers to this task).
--
-- workflow_outbox_message lets a handler record the *decision* to deliver
-- durably, in the same transaction as its own command-completion, instead
-- of performing the external call inline. The row committing or rolling
-- back together with completion is what makes the decision exactly-once;
-- actually sending it is a separate, later, idempotent step (claim + mark
-- delivered below) that a future concrete deliverer runs -- same "persist +
-- due-query only" boundary workflow_command itself shipped with (P4.A.3),
-- and the same "no live caller wired in yet" state as P4.A.2/P4.A.3/P4.A.4.
CREATE TABLE workflow_outbox_message (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id            uuid NOT NULL REFERENCES client(id),
  workflow_instance_id uuid NOT NULL REFERENCES workflow_instance(id),
  command_id           uuid NOT NULL REFERENCES workflow_command(id),
  dedupe_key           text NOT NULL,
  payload              jsonb NOT NULL DEFAULT '{}'::jsonb,
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'delivered')),
  attempts             int NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- Idempotent record: a handler re-run after a crash (before its own
  -- transaction committed the first time) derives the same dedupe_key and
  -- gets the existing row back rather than a second delivery intent.
  UNIQUE (client_id, dedupe_key)
);

-- Due-message scan, mirroring workflow_command_due_idx's shape: pending
-- rows only, tenant-scoped, cheap as delivered rows accumulate.
CREATE INDEX workflow_outbox_message_due_idx ON workflow_outbox_message (client_id, created_at)
  WHERE status = 'pending';
CREATE INDEX workflow_outbox_message_command_idx ON workflow_outbox_message (client_id, command_id);

SELECT apply_tenant_rls('workflow_outbox_message', 'client_id');

-- Mutable (status/attempts advance as a future deliverer claims and
-- delivers a message), matching workflow_command's own grant shape rather
-- than an append-only log's -- no DELETE granted: nothing in this task's
-- boundary ever removes a row.
GRANT SELECT, INSERT, UPDATE ON workflow_outbox_message TO freight_app;

-- Down Migration
REVOKE ALL ON workflow_outbox_message FROM freight_app;
DROP TABLE IF EXISTS workflow_outbox_message;
