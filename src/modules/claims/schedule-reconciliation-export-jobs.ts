import type pg from 'pg';
import type PgBoss from 'pg-boss';
import { enqueueInTransaction } from '../../jobs/enqueue.js';
import { JOB_NAMES } from '../../jobs/contracts.js';
import { claimDueReconciliationExports } from './reconciliation-export.js';

export interface ScheduleReconciliationExportJobsResult {
  enqueued: number;
}

/**
 * The reconciliation-export scan half (P5.C.5), mirroring
 * scheduleOutboxDeliveryJobs (P4.A.6) one level down the pipeline: for every
 * active client, atomically claims due reconciliation_export rows
 * (claimDueReconciliationExports -- the compare-and-set that keeps two
 * concurrent scans from double-claiming) and enqueues one
 * EXPORT_RECONCILIATION_V1 job per claimed row.
 *
 * Runs inside a single internal (cross-tenant) transaction, same shape as
 * scheduleOutboxDeliveryJobs: claimDueReconciliationExports trusts the
 * caller to have already scoped the query, so `client` here must come from
 * `withTenantTx({ internal: true }, ...)`.
 *
 * The enqueued idempotencyKey is the export row's own idempotency_key --
 * stable across every attempt, same rationale as the outbox scheduler's use
 * of dedupeKey.
 */
export async function scheduleReconciliationExportJobs(
  client: pg.PoolClient,
  boss: Pick<PgBoss, 'send'>,
  now: Date = new Date(),
): Promise<ScheduleReconciliationExportJobsResult> {
  const clients = await client.query<{ id: string }>(
    `SELECT id FROM client WHERE is_active = true`,
  );

  let enqueued = 0;

  for (const { id: clientId } of clients.rows) {
    const due = await claimDueReconciliationExports(client, { clientId, now });
    for (const exportRow of due) {
      await enqueueInTransaction(boss, client, clientId, JOB_NAMES.EXPORT_RECONCILIATION_V1, {
        schemaVersion: 1 as const,
        clientId,
        idempotencyKey: exportRow.idempotencyKey,
        requestedAt: now.toISOString(),
        exportId: exportRow.exportId,
      });
      enqueued += 1;
    }
  }

  return { enqueued };
}
