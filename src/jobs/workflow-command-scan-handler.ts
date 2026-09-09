import { withTenantTx } from '../db/tenant-context.js';
import { scheduleWorkflowCommandJobs, type ScheduleWorkflowCommandJobsResult } from '../modules/workflow/schedule-workflow-command-jobs.js';
import { reclaimStaleWorkflowCommandsForActiveClients, type ReclaimStaleWorkflowCommandsResult } from '../modules/workflow/reclaim-stale-workflow-commands.js';
import { JOB_NAMES } from './contracts.js';
import { makeReclaimAndScanJobHandler, type ReclaimAndScanJobDeps } from './make-reclaim-and-scan-job-handler.js';

export type WorkflowCommandScanResult = ScheduleWorkflowCommandJobsResult & ReclaimStaleWorkflowCommandsResult;
export type WorkflowCommandScanDeps = ReclaimAndScanJobDeps<ScheduleWorkflowCommandJobsResult, ReclaimStaleWorkflowCommandsResult>;

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
 * visible to the due-query claim that follows it. Shared handler shape
 * lives in make-reclaim-and-scan-job-handler.ts (86e367r8f).
 */
export const handleWorkflowCommandScanJob = makeReclaimAndScanJobHandler<
  ScheduleWorkflowCommandJobsResult,
  ReclaimStaleWorkflowCommandsResult
>(JOB_NAMES.SCAN_WORKFLOW_COMMANDS_V1, defaultDeps);
