-- Up Migration
-- P4.A.3: persisted deadlines + resumable commands for a workflow_instance
-- (P4.A.1/#183). A workflow_command is a durable row for "do X to this
-- workflow_instance at time Y, exactly once, even across a worker crash" --
-- run_after is the persisted deadline; the row surviving a crash IS the
-- resumability, nothing lives in memory. This item persists commands and
-- exposes the due-query only: it does not run them (P4.A.4's pg-boss
-- runner, still gated behind its own dependencies) and it is not
-- transactional outbox delivery (P4.A.5) -- those consume this table, they
-- are not built here.
--
-- NOT APPLIABLE until #183 (open, unmerged as of this migration) lands:
-- workflow_instance does not exist on Development yet. This migration
-- creates ONLY workflow_command (with a real FK to workflow_instance),
-- never a duplicate/IF-NOT-EXISTS workflow_instance -- two migrations
-- creating the same table under different numbers would silently diverge
-- or no-op depending on merge order, which is worse than a migration that
-- is honestly un-appliable until its prerequisite merges. Mirrors #169's
-- workflow_transition, which faced the identical situation.
--
-- Migration number 0053: 0045/0047/0048/0050/0051/0052 are open PRs as of
-- this migration; 0046/0049 are #183/#169 (also open, unmerged).
CREATE TABLE workflow_command (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id            uuid NOT NULL REFERENCES client(id),
  workflow_instance_id uuid NOT NULL REFERENCES workflow_instance(id),
  command_type         text NOT NULL CHECK (command_type ~ '^[a-z][a-z0-9_]*$'),
  payload              jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_after            timestamptz NOT NULL,
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'done')),
  attempts             int NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- Due-command scan: status='pending' AND run_after <= now(), scoped by
-- tenant. Partial index keeps it cheap as 'done' rows accumulate.
CREATE INDEX workflow_command_due_idx ON workflow_command (client_id, run_after)
  WHERE status = 'pending';
CREATE INDEX workflow_command_instance_idx ON workflow_command (client_id, workflow_instance_id);

SELECT apply_tenant_rls('workflow_command', 'client_id');

-- Mutable (status/attempts advance as a runner claims and completes a
-- command), so this gets the same full grant as workflow_instance itself
-- rather than the append-only INSERT+SELECT grant used for transition/event
-- logs -- there is no separate log table here to keep append-only, because
-- this item is deliberately scoped to persistence + the due-query, not
-- delivery/outbox semantics (P4.A.5).
GRANT SELECT, INSERT, UPDATE, DELETE ON workflow_command TO freight_app;

-- Down Migration
DROP TABLE IF EXISTS workflow_command;
