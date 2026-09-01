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
 * across every attempt, since deliver-outbox-message-handler.ts forwards it
 * straight through to the sender as that provider's own idempotency-key
 * mechanism (P4.A.6), so it can never fold in `attempts` the way
 * scheduleWorkflowCommandJobs's idempotencyKey does. The *job id* still has
 * to vary by attempts, though -- reclaimStaleOutboxMessages
 * (reclaim-stale-outbox-messages.ts, P4.A.8) closes the identical gap
 * P4.A.7 closed for workflow_command, so a message reclaimed back to
 * 'pending' after a stranded claim IS re-enqueued here on a later tick, and
 * without a distinct job id per attempt that re-enqueue would collide with
 * the first (now dead/expired) attempt's job id and silently no-op -- the
 * exact deterministic-job-id collision PR #232 fixed on the command side.
 * enqueueInTransaction's `jobIdKey` parameter carries this: derived from
 * (outboxMessageId, attempts) rather than the payload's own idempotencyKey,
 * so it can vary per attempt independently of the sender-facing dedupeKey
 * staying fixed.
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
      await enqueueInTransaction(
        boss,
        client,
        clientId,
        JOB_NAMES.DELIVER_OUTBOX_MESSAGE_V1,
        {
          schemaVersion: 1 as const,
          clientId,
          idempotencyKey: message.dedupeKey,
          requestedAt: now.toISOString(),
          outboxMessageId: message.outboxMessageId,
          workflowInstanceId: message.workflowInstanceId,
          commandId: message.commandId,
          messageType: message.messageType,
          payload: message.payload,
        },
        `workflow-outbox-message:${message.outboxMessageId}:${message.attempts}`,
      );
      enqueued += 1;
    }
  }

  return { enqueued };
}
