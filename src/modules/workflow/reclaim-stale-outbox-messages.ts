import type pg from 'pg';
import { reclaimStaleClaims, reclaimStaleClaimsForActiveClients, type ReclaimStaleClaimsInput } from './reclaim-stale-claims.js';

export interface ReclaimedOutboxMessage {
  outboxMessageId: string;
  workflowInstanceId: string;
  attempts: number;
  outcome: 'reclaimed' | 'failed';
}

const CONFIG = {
  table: 'workflow_outbox_message',
  entity: 'workflow_outbox_message',
  reclaimedEvent: 'workflow.outbox_message_reclaimed',
  failedEvent: 'workflow.outbox_message_failed',
} as const;

/**
 * Recovers workflow_outbox_message rows stranded in 'claimed' by a delivery
 * worker that crashed (or a sender that permanently failed) before
 * completeOutboxMessage ever ran -- the identical gap
 * reclaimStaleWorkflowCommands (P4.A.7) closed on the command side, which
 * schedule-outbox-delivery-jobs.ts's own docstring names and defers here.
 * Shared SQL/CAS logic lives in reclaim-stale-claims.ts (86e367r8f).
 *
 * staleAfterMinutes defaults comfortably above this queue's own pg-boss
 * retry budget (policies.ts: expireInMinutes 15, retryLimit 5 @ retryDelay
 * 30s backoff) so pg-boss's own retry gets first chance to resume a merely-
 * slow delivery before this reclaims the row out from under a still-in-
 * flight retry.
 */
export async function reclaimStaleOutboxMessages(
  client: pg.PoolClient,
  untrusted: ReclaimStaleClaimsInput,
): Promise<ReclaimedOutboxMessage[]> {
  const rows = await reclaimStaleClaims(client, CONFIG, untrusted);
  return rows.map((row) => ({
    outboxMessageId: row.id,
    workflowInstanceId: row.workflowInstanceId,
    attempts: row.attempts,
    outcome: row.outcome,
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
  return reclaimStaleClaimsForActiveClients(client, CONFIG, now);
}
