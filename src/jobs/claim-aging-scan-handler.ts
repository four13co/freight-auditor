import type PgBoss from 'pg-boss';
import type pg from 'pg';
import { withTenantTx, type TenantContext } from '../db/tenant-context.js';
import { scheduleClaimAgingJobs, type ScheduleClaimAgingJobsResult } from '../modules/claims/schedule-claim-aging-jobs.js';
import { parseJobPayload, JOB_NAMES } from './contracts.js';

export interface ClaimAgingScanDeps {
  withTenantTx: (ctx: TenantContext, fn: (client: pg.PoolClient) => Promise<ScheduleClaimAgingJobsResult>) => Promise<ScheduleClaimAgingJobsResult>;
  scan: typeof scheduleClaimAgingJobs;
}

const defaultDeps: ClaimAgingScanDeps = { withTenantTx, scan: scheduleClaimAgingJobs };

/**
 * Portfolio-wide tick (no tenant scope in the payload): scans every active
 * client for claims due a follow-up/escalation job. Runs in its own
 * internal transaction rather than the caller's, since this is a scheduled
 * scan, not a request on behalf of one tenant.
 */
export async function handleClaimAgingScanJob(
  boss: Pick<PgBoss, 'send'>,
  untrustedPayload: unknown,
  deps: ClaimAgingScanDeps = defaultDeps,
): Promise<ScheduleClaimAgingJobsResult> {
  const payload = parseJobPayload(JOB_NAMES.SCAN_CLAIM_AGING_V1, untrustedPayload);
  const now = new Date(payload.requestedAt);
  return deps.withTenantTx({ internal: true }, (client) => deps.scan(client, boss, now));
}
