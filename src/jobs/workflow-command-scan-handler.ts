import type PgBoss from 'pg-boss';
import type pg from 'pg';
import { withTenantTx, type TenantContext } from '../db/tenant-context.js';
import { scheduleWorkflowCommandJobs, type ScheduleWorkflowCommandJobsResult } from '../modules/workflow/schedule-workflow-command-jobs.js';
import { reclaimStaleWorkflowCommandsForActiveClients, type ReclaimStaleWorkflowCommandsResult } from '../modules/workflow/reclaim-stale-workflow-commands.js';
import { parseJobPayload, JOB_NAMES } from './contracts.js';

export type WorkflowCommandScanResult = ScheduleWorkflowCommandJobsResult & ReclaimStaleWorkflowCommandsResult;

export interface WorkflowCommandScanDeps {
  withTenantTx: (ctx: TenantContext, fn: (client: pg.PoolClient) => Promise<WorkflowCommandScanResult>) => Promise<WorkflowCommandScanResult>;
  reclaim: typeof reclaimStaleWorkflowCommandsForActiveClients;
  scan: typeof scheduleWorkflowCommandJobs;
}

const defaultDeps: WorkflowCommandScanDeps = {
  withTenantTx,
  reclaim: reclaimStaleWorkflowCommandsForActiveClients,
  scan: scheduleWorkflowCommandJobs,
};

/**
 * Portfolio-wide tick (no tenant scope in the payload): first recovers any
 * workflow_command stranded in 'claimed' by a worker/process crash (P4.A.7,
 * reclaimStaleWorkflowCommandsForActiveClients), then scans every active
 * client for due workflow_command rows and dispatches one job per claimed
 * command. Both run in the same internal transaction, mirroring
 * handleClaimAgingScanJob -- a scheduled scan, not a request on behalf of
 * one tenant -- so a row recovered back to 'pending' this tick is already
 * visible to the due-query claim that follows it.
 */
export async function handleWorkflowCommandScanJob(
  boss: Pick<PgBoss, 'send'>,
  untrustedPayload: unknown,
  deps: WorkflowCommandScanDeps = defaultDeps,
): Promise<WorkflowCommandScanResult> {
  const payload = parseJobPayload(JOB_NAMES.SCAN_WORKFLOW_COMMANDS_V1, untrustedPayload);
  const now = new Date(payload.requestedAt);
  return deps.withTenantTx({ internal: true }, async (client) => {
    const recovery = await deps.reclaim(client, now);
    const scanResult = await deps.scan(client, boss, now);
    return { ...scanResult, ...recovery };
  });
}
