import type PgBoss from 'pg-boss';
import type pg from 'pg';
import { withTenantTx, type TenantContext } from '../db/tenant-context.js';
import { scheduleOutboxDeliveryJobs, type ScheduleOutboxDeliveryJobsResult } from '../modules/workflow/schedule-outbox-delivery-jobs.js';
import { reclaimStaleOutboxMessagesForActiveClients, type ReclaimStaleOutboxMessagesResult } from '../modules/workflow/reclaim-stale-outbox-messages.js';
import { parseJobPayload, JOB_NAMES } from './contracts.js';

export type OutboxMessageScanResult = ScheduleOutboxDeliveryJobsResult & ReclaimStaleOutboxMessagesResult;

export interface OutboxMessageScanDeps {
  withTenantTx: (ctx: TenantContext, fn: (client: pg.PoolClient) => Promise<OutboxMessageScanResult>) => Promise<OutboxMessageScanResult>;
  reclaim: typeof reclaimStaleOutboxMessagesForActiveClients;
  scan: typeof scheduleOutboxDeliveryJobs;
}

const defaultDeps: OutboxMessageScanDeps = {
  withTenantTx,
  reclaim: reclaimStaleOutboxMessagesForActiveClients,
  scan: scheduleOutboxDeliveryJobs,
};

/**
 * Portfolio-wide tick (no tenant scope in the payload): first recovers any
 * workflow_outbox_message stranded in 'claimed' by a delivery worker crash
 * (P4.A.8, reclaimStaleOutboxMessagesForActiveClients), then scans every
 * active client for due workflow_outbox_message rows and dispatches one job
 * per claimed message. Both run in the same internal transaction, mirroring
 * handleWorkflowCommandScanJob one level up the pipeline -- a scheduled
 * scan, not a request on behalf of one tenant -- so a row recovered back to
 * 'pending' this tick is already visible to the due-query claim that
 * follows it.
 */
export async function handleOutboxMessageScanJob(
  boss: Pick<PgBoss, 'send'>,
  untrustedPayload: unknown,
  deps: OutboxMessageScanDeps = defaultDeps,
): Promise<OutboxMessageScanResult> {
  const payload = parseJobPayload(JOB_NAMES.SCAN_OUTBOX_MESSAGES_V1, untrustedPayload);
  const now = new Date(payload.requestedAt);
  return deps.withTenantTx({ internal: true }, async (client) => {
    const recovery = await deps.reclaim(client, now);
    const scanResult = await deps.scan(client, boss, now);
    return { ...scanResult, ...recovery };
  });
}
