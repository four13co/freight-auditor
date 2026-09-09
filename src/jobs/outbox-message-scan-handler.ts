import { withTenantTx } from '../db/tenant-context.js';
import { scheduleOutboxDeliveryJobs, type ScheduleOutboxDeliveryJobsResult } from '../modules/workflow/schedule-outbox-delivery-jobs.js';
import { reclaimStaleOutboxMessagesForActiveClients, type ReclaimStaleOutboxMessagesResult } from '../modules/workflow/reclaim-stale-outbox-messages.js';
import { JOB_NAMES } from './contracts.js';
import { makeReclaimAndScanJobHandler, type ReclaimAndScanJobDeps } from './make-reclaim-and-scan-job-handler.js';

export type OutboxMessageScanResult = ScheduleOutboxDeliveryJobsResult & ReclaimStaleOutboxMessagesResult;
export type OutboxMessageScanDeps = ReclaimAndScanJobDeps<ScheduleOutboxDeliveryJobsResult, ReclaimStaleOutboxMessagesResult>;

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
 * follows it. Shared handler shape lives in
 * make-reclaim-and-scan-job-handler.ts (86e367r8f).
 */
export const handleOutboxMessageScanJob = makeReclaimAndScanJobHandler<
  ScheduleOutboxDeliveryJobsResult,
  ReclaimStaleOutboxMessagesResult
>(JOB_NAMES.SCAN_OUTBOX_MESSAGES_V1, defaultDeps);
