import type pg from 'pg';
import type PgBoss from 'pg-boss';
import { enqueueInTransaction } from '../../jobs/enqueue.js';
import { JOB_NAMES } from '../../jobs/contracts.js';
import { claimDueOutboxMessages } from './workflow-outbox.js';

export interface ScheduleOutboxDeliveryJobsResult {
  enqueued: number;
}

/**
 * The outbox deliverer's scan half (P4.A.6), mirroring
 * scheduleWorkflowCommandJobs (P4.A.4) one level down the pipeline: for
 * every active client, atomically claims due workflow_outbox_message rows
 * (claimDueOutboxMessages -- the compare-and-set that keeps two concurrent
 * scans from double-claiming) and enqueues one DELIVER_OUTBOX_MESSAGE_V1 job
 * per claimed message.
 *
 * Runs inside a single internal (cross-tenant) transaction, same shape as
 * scheduleWorkflowCommandJobs: claimDueOutboxMessages trusts the caller to
 * have already scoped the query, so `client` here must come from
 * `withTenantTx({ internal: true }, ...)`.
 *
 * The enqueued idempotencyKey is the message's own dedupeKey -- unchanged
 * across every attempt (unlike a job id derived from attempts, which would
 * need attempts folded in to avoid a stale reclaim silently no-opping, see
 * PR #232). Nothing here reclaims a stranded 'claimed' row yet (that gap is
 * the identical one P4.A.7 closed for workflow_command, explicitly flagged
 * as a future sibling task for the outbox side), so this schedule function
 * only ever enqueues a message once per its single pending->claimed
 * transition -- the deterministic-job-id collision PR #232 fixed can't yet
 * arise here for the same reason it doesn't need fixing pre-#232 on the
 * command side: no re-enqueue path exists without a reclaimer.
 */
export async function scheduleOutboxDeliveryJobs(
  client: pg.PoolClient,
  boss: Pick<PgBoss, 'send'>,
  now: Date = new Date(),
): Promise<ScheduleOutboxDeliveryJobsResult> {
  const clients = await client.query<{ id: string }>(
    `SELECT id FROM client WHERE is_active = true`,
  );

  let enqueued = 0;

  for (const { id: clientId } of clients.rows) {
    const due = await claimDueOutboxMessages(client, { clientId, now });
    for (const message of due) {
      await enqueueInTransaction(boss, client, clientId, JOB_NAMES.DELIVER_OUTBOX_MESSAGE_V1, {
        schemaVersion: 1 as const,
        clientId,
        idempotencyKey: message.dedupeKey,
        requestedAt: now.toISOString(),
        outboxMessageId: message.outboxMessageId,
        workflowInstanceId: message.workflowInstanceId,
        commandId: message.commandId,
        messageType: message.messageType,
        payload: message.payload,
      });
      enqueued += 1;
    }
  }

  return { enqueued };
}
