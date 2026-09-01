import type PgBoss from 'pg-boss';
import type pg from 'pg';
import { withTenantTx, type TenantContext } from '../db/tenant-context.js';
import { scheduleOutboxDeliveryJobs, type ScheduleOutboxDeliveryJobsResult } from '../modules/workflow/schedule-outbox-delivery-jobs.js';
import { parseJobPayload, JOB_NAMES } from './contracts.js';

export interface OutboxMessageScanDeps {
  withTenantTx: (ctx: TenantContext, fn: (client: pg.PoolClient) => Promise<ScheduleOutboxDeliveryJobsResult>) => Promise<ScheduleOutboxDeliveryJobsResult>;
  scan: typeof scheduleOutboxDeliveryJobs;
}

const defaultDeps: OutboxMessageScanDeps = { withTenantTx, scan: scheduleOutboxDeliveryJobs };

/**
 * Portfolio-wide tick (no tenant scope in the payload): scans every active
 * client for due workflow_outbox_message rows and dispatches one job per
 * claimed message. Runs in its own internal transaction, mirroring
 * handleWorkflowCommandScanJob one level down the pipeline.
 */
export async function handleOutboxMessageScanJob(
  boss: Pick<PgBoss, 'send'>,
  untrustedPayload: unknown,
  deps: OutboxMessageScanDeps = defaultDeps,
): Promise<ScheduleOutboxDeliveryJobsResult> {
  const payload = parseJobPayload(JOB_NAMES.SCAN_OUTBOX_MESSAGES_V1, untrustedPayload);
  const now = new Date(payload.requestedAt);
  return deps.withTenantTx({ internal: true }, (client) => deps.scan(client, boss, now));
}
