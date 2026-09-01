import type PgBoss from 'pg-boss';
import type pg from 'pg';
import { withTenantTx, type TenantContext } from '../db/tenant-context.js';
import { scheduleWorkflowCommandJobs, type ScheduleWorkflowCommandJobsResult } from '../modules/workflow/schedule-workflow-command-jobs.js';
import { parseJobPayload, JOB_NAMES } from './contracts.js';

export interface WorkflowCommandScanDeps {
  withTenantTx: (ctx: TenantContext, fn: (client: pg.PoolClient) => Promise<ScheduleWorkflowCommandJobsResult>) => Promise<ScheduleWorkflowCommandJobsResult>;
  scan: typeof scheduleWorkflowCommandJobs;
}

const defaultDeps: WorkflowCommandScanDeps = { withTenantTx, scan: scheduleWorkflowCommandJobs };

/**
 * Portfolio-wide tick (no tenant scope in the payload): scans every active
 * client for due workflow_command rows and dispatches one job per claimed
 * command. Runs in its own internal transaction, mirroring
 * handleClaimAgingScanJob -- a scheduled scan, not a request on behalf of
 * one tenant.
 */
export async function handleWorkflowCommandScanJob(
  boss: Pick<PgBoss, 'send'>,
  untrustedPayload: unknown,
  deps: WorkflowCommandScanDeps = defaultDeps,
): Promise<ScheduleWorkflowCommandJobsResult> {
  const payload = parseJobPayload(JOB_NAMES.SCAN_WORKFLOW_COMMANDS_V1, untrustedPayload);
  const now = new Date(payload.requestedAt);
  return deps.withTenantTx({ internal: true }, (client) => deps.scan(client, boss, now));
}
