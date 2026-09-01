import type pg from 'pg';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';
import { createWorkflowInstance } from '../workflow/create-workflow-instance.js';
import { scheduleWorkflowCommand } from '../workflow/schedule-workflow-command.js';
import { DELIVER_DISPUTE_COMMAND_TYPE } from './deliver-dispute-command-handler.js';

const DISPUTE_DELIVERY_WORKFLOW_TYPE = 'dispute_delivery';
const DISPUTE_DELIVERY_INITIAL_STATE = 'pending_delivery';

export interface ApproveDisputeResult {
  /** false when the dispute doesn't exist, isn't visible under RLS, or is not currently 'draft' -- caller maps this to 404/409 as appropriate. */
  found: boolean;
}

/**
 * Approves a draft dispute for delivery (P4.C.6): draft -> sent. Unlike
 * update-finding-status.ts's CTE-chain pattern (which keeps a mutable
 * current-state row in sync with its OWN append-only history table),
 * dispute has no dispute_status_event history table -- so this is a plain
 * guarded UPDATE + writeAuditEvent.
 *
 * `WHERE status = 'draft'` guards the from-state: approving an
 * already-sent (or otherwise non-draft) dispute is a no-op returning
 * `found: false` rather than silently re-sending it -- this IS the
 * idempotency guarantee, since there is no separate history row to make
 * a duplicate transition detectable after the fact. It also means the
 * workflow/command creation below (P4.C.7) only ever runs once per dispute:
 * a retried/duplicate approve request that lands after the first one
 * already flipped the row hits `found: false` and schedules nothing a
 * second time.
 *
 * P4.C.7: within this same transaction, creates a workflow_instance
 * (workflow_type='dispute_delivery', subject=dispute) and schedules a
 * deliver_dispute workflow_command against it (run_after=now, i.e. due
 * immediately). Both createWorkflowInstance and scheduleWorkflowCommand are
 * themselves idempotent inserts, so this stays safe even if the surrounding
 * transaction is retried before it ever commits. Delivery itself is
 * durable and resumable from here on: schedule-workflow-command-jobs.ts's
 * per-minute scan claims the due command and runs
 * deliver-dispute-command-handler.ts's handler, which records an outbox
 * delivery intent (recordOutboxMessage) rather than calling out to a
 * carrier inline -- see that handler's own doc comments for why no actual
 * carrier-contact sender is registered yet.
 */
export async function approveDispute(
  client: pg.PoolClient,
  disputeId: string,
  actorUserId: string,
  now: Date = new Date(),
): Promise<ApproveDisputeResult> {
  const result = await client.query<{ id: string; client_id: string }>(
    `UPDATE dispute SET status = 'sent' WHERE id = $1 AND status = 'draft' RETURNING id, client_id`,
    [disputeId],
  );

  const row = result.rows[0];
  if (!row) return { found: false };

  await writeAuditEvent(client, {
    id: deterministicAuditEventId(row.client_id, row.id, 'dispute.approved'),
    clientId: row.client_id,
    entity: 'dispute',
    entityId: row.id,
    event: 'dispute.approved',
    actorKind: 'analyst',
    actorUserId,
    detail: { fromStatus: 'draft', toStatus: 'sent' },
  });

  const workflowInstance = await createWorkflowInstance(client, {
    clientId: row.client_id,
    workflowType: DISPUTE_DELIVERY_WORKFLOW_TYPE,
    subjectEntity: 'dispute',
    subjectEntityId: row.id,
    initialState: DISPUTE_DELIVERY_INITIAL_STATE,
  });

  await scheduleWorkflowCommand(client, {
    clientId: row.client_id,
    workflowInstanceId: workflowInstance.id,
    commandType: DELIVER_DISPUTE_COMMAND_TYPE,
    payload: { disputeId: row.id },
    runAfter: now,
  });

  return { found: true };
}
