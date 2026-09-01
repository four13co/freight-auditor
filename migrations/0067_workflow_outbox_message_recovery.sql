-- Up Migration
-- P4.A.8: recover workflow_outbox_message rows stranded in 'claimed' by a
-- delivery worker that crashed (or a sender that permanently failed) before
-- completeOutboxMessage ever ran. This is the identical gap P4.A.7 (0064)
-- closed for workflow_command, explicitly flagged as a future sibling task
-- by schedule-outbox-delivery-jobs.ts's own docstring: "Nothing here
-- reclaims a stranded 'claimed' row yet (that gap is the identical one
-- P4.A.7 closed for workflow_command, explicitly flagged as a future
-- sibling task for the outbox side)."
--
-- claimed_at records when a row was flipped to 'claimed' (claimDueOutbox-
-- Messages sets it going forward, mirroring claimDueWorkflowCommands); a
-- scan can then find rows claimed longer ago than this queue's own pg-boss
-- retry budget can plausibly still be working (policies.ts: expireInMinutes
-- 15, retryLimit 5 @ retryDelay 30s backoff) and recover them -- back to
-- 'pending' for a fresh claim if attempts budget remains, or to a new
-- terminal 'failed' state once attempts is exhausted, so a permanently-
-- stuck message becomes a visible, auditable dead end instead of an
-- invisible stalled row (the due-index is WHERE status='pending', so a
-- stranded 'claimed' row is invisible to every existing query today).
ALTER TABLE workflow_outbox_message ADD COLUMN claimed_at timestamptz;

ALTER TABLE workflow_outbox_message DROP CONSTRAINT workflow_outbox_message_status_check;
ALTER TABLE workflow_outbox_message ADD CONSTRAINT workflow_outbox_message_status_check
  CHECK (status IN ('pending', 'claimed', 'delivered', 'failed'));

-- Stale-claim scan: status='claimed' rows ordered by how long they've been
-- claimed, mirroring workflow_command_stale_claim_idx's partial-index shape.
CREATE INDEX workflow_outbox_message_stale_claim_idx ON workflow_outbox_message (client_id, claimed_at)
  WHERE status = 'claimed';

-- Down Migration
DROP INDEX IF EXISTS workflow_outbox_message_stale_claim_idx;
ALTER TABLE workflow_outbox_message DROP CONSTRAINT workflow_outbox_message_status_check;
ALTER TABLE workflow_outbox_message ADD CONSTRAINT workflow_outbox_message_status_check
  CHECK (status IN ('pending', 'claimed', 'delivered'));
ALTER TABLE workflow_outbox_message DROP COLUMN claimed_at;
