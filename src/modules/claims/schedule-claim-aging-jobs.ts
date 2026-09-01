import type pg from 'pg';
import type PgBoss from 'pg-boss';
import { enqueueInTransaction } from '../../jobs/enqueue.js';
import { JOB_NAMES } from '../../jobs/contracts.js';
import { listClaimsDueForEscalation, listClaimsDueForFollowUp } from './list-claim-aging-queues.js';

export interface ScheduleClaimAgingJobsResult {
  followUpEnqueued: number;
  escalationEnqueued: number;
}

/**
 * Scans every active client for claims past their follow-up/escalation
 * deadline and enqueues one job per claim. Runs inside a single internal
 * (cross-tenant) transaction: listClaimsDueFor* trust the caller to have
 * already scoped the query, so `client` here must come from
 * `withTenantTx({ internal: true }, ...)`, never a per-tenant scope.
 *
 * Each enqueue goes through enqueueInTransaction, not a direct boss.send --
 * that routes pg-boss's own insert through this same `client`, so the job
 * row commits or rolls back atomically with whatever else runs in this
 * transaction (there's nothing else here today, but a future caller that
 * wraps this in a larger unit of work gets a correct guarantee instead of
 * an inherited landmine).
 *
 * Idempotent per claim: enqueueInTransaction derives the job id from (job
 * name, clientId, idempotencyKey) rather than a timestamp, so re-running
 * the scan before a previously enqueued job has been processed resends the
 * same id -- pg-boss no-ops on a colliding id instead of creating a
 * duplicate.
 */
export async function scheduleClaimAgingJobs(
  client: pg.PoolClient,
  boss: Pick<PgBoss, 'send'>,
  now: Date = new Date(),
): Promise<ScheduleClaimAgingJobsResult> {
  const clients = await client.query<{ id: string }>(
    `SELECT id FROM client WHERE is_active = true`,
  );

  let followUpEnqueued = 0;
  let escalationEnqueued = 0;

  for (const { id: clientId } of clients.rows) {
    const dueForFollowUp = await listClaimsDueForFollowUp(client, { clientId, now });
    for (const entry of dueForFollowUp) {
      await enqueueInTransaction(boss, client, clientId, JOB_NAMES.FOLLOW_UP_CLAIM_V1, {
        schemaVersion: 1 as const,
        clientId,
        idempotencyKey: `claim-follow-up:${entry.claimId}`,
        requestedAt: now.toISOString(),
        claimId: entry.claimId,
      });
      followUpEnqueued += 1;
    }

    const dueForEscalation = await listClaimsDueForEscalation(client, { clientId, now });
    for (const entry of dueForEscalation) {
      await enqueueInTransaction(boss, client, clientId, JOB_NAMES.ESCALATE_CLAIM_V1, {
        schemaVersion: 1 as const,
        clientId,
        idempotencyKey: `claim-escalation:${entry.claimId}`,
        requestedAt: now.toISOString(),
        claimId: entry.claimId,
      });
      escalationEnqueued += 1;
    }
  }

  return { followUpEnqueued, escalationEnqueued };
}
