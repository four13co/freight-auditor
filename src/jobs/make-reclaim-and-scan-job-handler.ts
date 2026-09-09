import type PgBoss from 'pg-boss';
import type pg from 'pg';
import type { TenantContext } from '../db/tenant-context.js';
import { parseJobPayload, JOB_NAMES } from './contracts.js';

type ReclaimAndScanJobName =
  | typeof JOB_NAMES.SCAN_OUTBOX_MESSAGES_V1
  | typeof JOB_NAMES.SCAN_WORKFLOW_COMMANDS_V1;

export interface ReclaimAndScanJobDeps<ScanResult extends object, ReclaimResult extends object> {
  withTenantTx: (
    ctx: TenantContext,
    fn: (client: pg.PoolClient) => Promise<ScanResult & ReclaimResult>,
  ) => Promise<ScanResult & ReclaimResult>;
  reclaim: (client: pg.PoolClient, now: Date) => Promise<ReclaimResult>;
  scan: (client: pg.PoolClient, boss: Pick<PgBoss, 'send'>, now: Date) => Promise<ScanResult>;
}

/**
 * 86e367r8f: shared factory behind handleOutboxMessageScanJob and
 * handleWorkflowCommandScanJob -- both first recover any row stranded in
 * 'claimed' by a worker/process crash, then scan every active client for
 * due work, in the SAME internal (cross-tenant) transaction, so a row
 * recovered back to 'pending' this tick is already visible to the
 * due-query claim that follows it. `defaultDeps` (production reclaim/scan
 * functions) is captured once per handler; a caller may still override any
 * of the three deps per-call (existing test pattern).
 */
export function makeReclaimAndScanJobHandler<ScanResult extends object, ReclaimResult extends object>(
  jobName: ReclaimAndScanJobName,
  defaultDeps: ReclaimAndScanJobDeps<ScanResult, ReclaimResult>,
) {
  return async function handleReclaimAndScanJob(
    boss: Pick<PgBoss, 'send'>,
    untrustedPayload: unknown,
    deps: ReclaimAndScanJobDeps<ScanResult, ReclaimResult> = defaultDeps,
  ): Promise<ScanResult & ReclaimResult> {
    const payload = parseJobPayload(jobName, untrustedPayload);
    const now = new Date(payload.requestedAt);
    return deps.withTenantTx({ internal: true }, async (client) => {
      const recovery = await deps.reclaim(client, now);
      const scanResult = await deps.scan(client, boss, now);
      return { ...scanResult, ...recovery };
    });
  };
}
