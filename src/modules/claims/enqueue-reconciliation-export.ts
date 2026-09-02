import type pg from 'pg';
import type PgBoss from 'pg-boss';
import { enqueueInTransaction, type EnqueueResult } from '../../jobs/enqueue.js';
import { JOB_NAMES } from '../../jobs/contracts.js';

/**
 * No per-client AP/ERP system configuration exists yet -- P4.B.8 shipped
 * ExportAdapterRegistry empty by design, deliberately deferring which
 * vendor(s) a client targets. Every systemCode resolves NOT_CONFIGURED until
 * a future task registers a real adapter and a per-client target; this
 * constant is the placeholder until that config exists (86e2zfjjg).
 */
export const DEFAULT_RECONCILIATION_EXPORT_SYSTEM_CODE = 'DEFAULT_AP_ERP';

export interface EnqueueReconciliationExportParams {
  clientId: string;
  claimId: string;
  recoveryEventId: string;
  amountRecovered: string;
  currency: string;
  varianceFindingId: string | null;
  requestedAt?: Date;
}

/**
 * Enqueues one EXPORT_RECORD_V1 job carrying a recovery_event's
 * reconciliation data (P5.C.5), through the caller's own transaction client
 * -- mirroring scheduleClaimAgingJobs's enqueueInTransaction usage so the
 * job row commits/rolls back atomically with the recovery_event write.
 *
 * dedupeKey (the job's idempotencyKey) derives from recoveryEventId alone,
 * not a timestamp -- enqueueInTransaction turns that into a deterministic
 * pg-boss job id, so re-invoking this for the same recoveryEventId (e.g. a
 * retried request that replays the same already-recorded event) no-ops
 * (EnqueueResult.inserted: false) instead of double-exporting. A genuinely
 * new recovery_event (recordPartialRecovery is append-only/non-idempotent by
 * its own design) always carries a new id, so it always gets its own export.
 */
export async function enqueueReconciliationExport(
  client: pg.PoolClient,
  boss: Pick<PgBoss, 'send'>,
  params: EnqueueReconciliationExportParams,
): Promise<EnqueueResult> {
  const requestedAt = params.requestedAt ?? new Date();
  return enqueueInTransaction(boss, client, params.clientId, JOB_NAMES.EXPORT_RECORD_V1, {
    schemaVersion: 1 as const,
    clientId: params.clientId,
    idempotencyKey: `recovery-export:${params.recoveryEventId}`,
    requestedAt: requestedAt.toISOString(),
    claimId: params.claimId,
    paymentGateDecisionId: null,
    systemCode: DEFAULT_RECONCILIATION_EXPORT_SYSTEM_CODE,
    payload: {
      recoveryEventId: params.recoveryEventId,
      claimId: params.claimId,
      amountRecovered: params.amountRecovered,
      currency: params.currency,
      varianceFindingId: params.varianceFindingId,
    },
  });
}
