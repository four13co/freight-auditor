import type PgBoss from 'pg-boss';
import type pg from 'pg';
import { withTenantTx, type TenantContext } from '../db/tenant-context.js';
import { scheduleReconciliationExportJobs, type ScheduleReconciliationExportJobsResult } from '../modules/claims/schedule-reconciliation-export-jobs.js';
import { parseJobPayload, JOB_NAMES } from './contracts.js';

export interface ReconciliationExportScanDeps {
  withTenantTx: (ctx: TenantContext, fn: (client: pg.PoolClient) => Promise<ScheduleReconciliationExportJobsResult>) => Promise<ScheduleReconciliationExportJobsResult>;
  scan: typeof scheduleReconciliationExportJobs;
}

const defaultDeps: ReconciliationExportScanDeps = { withTenantTx, scan: scheduleReconciliationExportJobs };

/**
 * Portfolio-wide tick (no tenant scope in the payload): scans every active
 * client for pending reconciliation_export rows and dispatches one job per
 * claimed export. Runs in its own internal transaction, mirroring
 * handleOutboxMessageScanJob one level down the pipeline.
 */
export async function handleReconciliationExportScanJob(
  boss: Pick<PgBoss, 'send'>,
  untrustedPayload: unknown,
  deps: ReconciliationExportScanDeps = defaultDeps,
): Promise<ScheduleReconciliationExportJobsResult> {
  const payload = parseJobPayload(JOB_NAMES.SCAN_RECONCILIATION_EXPORTS_V1, untrustedPayload);
  const now = new Date(payload.requestedAt);
  return deps.withTenantTx({ internal: true }, (client) => deps.scan(client, boss, now));
}
