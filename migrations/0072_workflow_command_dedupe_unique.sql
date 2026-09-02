-- Up Migration
-- 86e32tfwq: scheduleWorkflowCommand's own docstring claims it is "idempotent
-- per (workflowInstanceId, commandType, runAfter)", but until now that claim
-- was backed only by an app-level SELECT-then-INSERT -- no DB constraint
-- stopped two concurrent callers from both passing the SELECT and each
-- inserting a row. Contrast with the sibling workflow_outbox_message
-- (migration 0063, PR #233's fix for the identical bug class), which backs
-- its own dedupe claim with a real UNIQUE constraint plus
-- INSERT ... ON CONFLICT DO NOTHING.
--
-- Unconditional across all `status` values (not just 'pending'), matching
-- workflow_outbox_message's own unconditional UNIQUE(client_id, dedupe_key)
-- -- the idempotency claim in the docstring is not scoped to any particular
-- status, so neither is the constraint that backs it.
--
-- Migration number 0072: 0069 is claimed by open PR #255
-- (dispute-response-transitions), 0071 by open PR #260
-- (rule-backtest-rls-guc); re-confirmed free of every other open PR's
-- migrations as of this write.
ALTER TABLE workflow_command
  ADD CONSTRAINT workflow_command_dedupe_key
  UNIQUE (client_id, workflow_instance_id, command_type, run_after);

-- Down Migration
ALTER TABLE workflow_command DROP CONSTRAINT workflow_command_dedupe_key;
