-- Up Migration
-- P4.A.7: recover workflow_command rows stranded in 'claimed' by a worker
-- process that crashed (or a job that permanently failed) before calling
-- completeWorkflowCommand. schedule-workflow-command-jobs.ts's own docstring
-- names this exact gap: "What happens if the claimed command's job never
-- completes (worker crash, permanent handler failure) is explicitly out of
-- this task's boundary -- recovery is P4.A.7, not built here."
--
-- claimed_at records when a row was flipped to 'claimed' (claimDueWorkflow-
-- Commands sets it going forward); a scan can then find rows claimed longer
-- ago than this queue's own pg-boss retry budget can plausibly still be
-- working (policies.ts: expireInMinutes 15, retryLimit 5 @ retryDelay 30s
-- backoff) and recover them -- back to 'pending' for a fresh claim if
-- attempts budget remains, or to a new terminal 'failed' state once
-- attempts is exhausted, so a permanently-stuck command becomes a visible,
-- auditable dead end instead of an invisible stalled row (the due-index is
-- WHERE status='pending', so a stranded 'claimed' row is invisible to every
-- existing query today).
ALTER TABLE workflow_command ADD COLUMN claimed_at timestamptz;

ALTER TABLE workflow_command DROP CONSTRAINT workflow_command_status_check;
ALTER TABLE workflow_command ADD CONSTRAINT workflow_command_status_check
  CHECK (status IN ('pending', 'claimed', 'done', 'failed'));

-- Stale-claim scan: status='claimed' rows ordered by how long they've been
-- claimed, mirroring workflow_command_due_idx's partial-index shape.
CREATE INDEX workflow_command_stale_claim_idx ON workflow_command (client_id, claimed_at)
  WHERE status = 'claimed';

-- Down Migration
DROP INDEX IF EXISTS workflow_command_stale_claim_idx;
ALTER TABLE workflow_command DROP CONSTRAINT workflow_command_status_check;
ALTER TABLE workflow_command ADD CONSTRAINT workflow_command_status_check
  CHECK (status IN ('pending', 'claimed', 'done'));
ALTER TABLE workflow_command DROP COLUMN claimed_at;
