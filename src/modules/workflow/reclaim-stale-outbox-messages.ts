import type pg from 'pg';
import { z } from 'zod';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';

const schema = z.object({
  clientId: z.uuid(),
  now: z.date().default(() => new Date()),
  staleAfterMinutes: z.number().int().positive().default(30),
  maxAttempts: z.number().int().positive().default(5),
  limit: z.number().int().positive().max(100).default(20),
}).strict();

export interface ReclaimedOutboxMessage {
  outboxMessageId: string;
  workflowInstanceId: string;
  attempts: number;
  outcome: 'reclaimed' | 'failed';
}

/**
 * Recovers workflow_outbox_message rows stranded in 'claimed' by a delivery
 * worker that crashed (or a sender that permanently failed) before
 * completeOutboxMessage ever ran -- the identical gap
 * reclaimStaleWorkflowCommands (P4.A.7) closed on the command side, which
 * schedule-outbox-delivery-jobs.ts's own docstring names and defers here.
 *
 * A row claimed more than staleAfterMinutes ago is recovered one of two
 * ways: back to 'pending' (claimed_at cleared) for a fresh claim if attempts
 * is still under maxAttempts, or to a terminal 'failed' state once
 * exhausted -- so a permanently-stuck message becomes a visible, auditable
 * dead end instead of an invisible stalled row (workflow_outbox_message_due_idx
 * is WHERE status='pending', so a stranded 'claimed' row is invisible to
 * every pre-existing query).
 *
 * staleAfterMinutes defaults comfortably above this queue's own pg-boss
 * retry budget (policies.ts: expireInMinutes 15, retryLimit 5 @ retryDelay
 * 30s backoff) so pg-boss's own retry gets first chance to resume a merely-
 * slow delivery before this reclaims the row out from under a still-in-
 * flight retry.
 *
 * Same UPDATE...RETURNING FOR UPDATE SKIP LOCKED compare-and-set shape as
 * claimDueOutboxMessages, so two concurrent scans can never both recover
 * the same row.
 */
export async function reclaimStaleOutboxMessages(
  client: pg.PoolClient,
  untrusted: z.input<typeof schema>,
): Promise<ReclaimedOutboxMessage[]> {
  const input = schema.parse(untrusted);
  const cutoff = new Date(input.now.getTime() - input.staleAfterMinutes * 60_000);

  const result = await client.query<{
    id: string;
    workflow_instance_id: string;
    attempts: number;
    status: string;
  }>(
    `UPDATE workflow_outbox_message
     SET status = CASE WHEN attempts >= $4 THEN 'failed' ELSE 'pending' END,
         claimed_at = NULL
     WHERE id IN (
       SELECT id FROM workflow_outbox_message
       WHERE client_id = $1 AND status = 'claimed' AND claimed_at <= $2
       ORDER BY claimed_at
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, workflow_instance_id, attempts, status`,
    [input.clientId, cutoff.toISOString(), input.limit, input.maxAttempts],
  );

  return result.rows.map((row) => ({
    outboxMessageId: row.id,
    workflowInstanceId: row.workflow_instance_id,
    attempts: row.attempts,
    outcome: row.status === 'failed' ? 'failed' : 'reclaimed',
  }));
}

export interface ReclaimStaleOutboxMessagesResult {
  reclaimed: number;
  failed: number;
}

/**
 * Portfolio-wide tick: recovers stale claims for every active client and
 * records one audit event per row recovered, mirroring
 * reclaimStaleWorkflowCommandsForActiveClients's own shape. Meant to run
 * from the same internal (cross-tenant) transaction as
 * scheduleOutboxDeliveryJobs, immediately before it, so a row recovered
 * back to 'pending' this tick is visible to the due-query claim that
 * follows in the same transaction.
 */
export async function reclaimStaleOutboxMessagesForActiveClients(
  client: pg.PoolClient,
  now: Date = new Date(),
): Promise<ReclaimStaleOutboxMessagesResult> {
  const clients = await client.query<{ id: string }>(
    `SELECT id FROM client WHERE is_active = true`,
  );

  let reclaimed = 0;
  let failed = 0;

  for (const { id: clientId } of clients.rows) {
    const rows = await reclaimStaleOutboxMessages(client, { clientId, now });
    for (const row of rows) {
      if (row.outcome === 'failed') failed += 1;
      else reclaimed += 1;

      const event = row.outcome === 'failed' ? 'workflow.outbox_message_failed' : 'workflow.outbox_message_reclaimed';
      await writeAuditEvent(client, {
        id: deterministicAuditEventId(clientId, row.outboxMessageId, event, String(row.attempts)),
        clientId,
        entity: 'workflow_outbox_message',
        entityId: row.outboxMessageId,
        event,
        actorKind: 'system',
        detail: { workflowInstanceId: row.workflowInstanceId, attempts: row.attempts },
      });
    }
  }

  return { reclaimed, failed };
}
