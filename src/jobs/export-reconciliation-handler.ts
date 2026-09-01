import type pg from 'pg';
import { getPortfolioReconciliation } from '../modules/claims/get-portfolio-reconciliation.js';
import { completeReconciliationExport, failReconciliationExport } from '../modules/claims/reconciliation-export.js';
import { parseJobPayload, JOB_NAMES } from './contracts.js';

export interface ExportReconciliationDeps {
  compute: typeof getPortfolioReconciliation;
  complete: typeof completeReconciliationExport;
  fail: typeof failReconciliationExport;
}

const defaultDeps: ExportReconciliationDeps = {
  compute: getPortfolioReconciliation,
  complete: completeReconciliationExport,
  fail: failReconciliationExport,
};

/** Never surfaces the raw error (message/stack can carry query text or other internals) to the export row a tenant polls -- a fixed, generic reason is the only thing ever written to `error`. */
const GENERIC_FAILURE_REASON = 'reconciliation export failed; contact support if this persists';

/**
 * Executes one already-claimed reconciliation_export (P5.C.5) by computing
 * its tenant's portfolio reconciliation (getPortfolioReconciliation, P5.C.4)
 * and marking the row completed with the result.
 *
 * Unlike handleDeliverOutboxMessageJob (which lets an unhandled error leave
 * the row 'claimed' for pg-boss's own retry/dead-letter accounting to
 * handle), this row IS the user-facing status object an analyst polls --
 * leaving it silently 'claimed' forever with no visible failure would be a
 * worse failure mode than an accurate 'failed' status. So: catch, mark
 * 'failed' with a generic reason (never the raw error), and deliberately do
 * NOT rethrow -- boss.ts wires this handler inside withTenantTx, which
 * ROLLBACKs the whole transaction (undoing the fail-write too) on any
 * exception that escapes fn (tenant-context.ts). Swallowing here is what
 * lets the fail-write actually commit; pg-boss sees the job as resolved
 * rather than retrying/dead-lettering it, which is correct since the export
 * row itself is now the durable, accurate record of the outcome.
 */
export async function handleExportReconciliationJob(
  client: pg.PoolClient,
  untrustedPayload: unknown,
  deps: ExportReconciliationDeps = defaultDeps,
): Promise<void> {
  const payload = parseJobPayload(JOB_NAMES.EXPORT_RECONCILIATION_V1, untrustedPayload);

  let result;
  try {
    result = await deps.compute(client, { clientId: payload.clientId });
  } catch {
    await deps.fail(client, {
      clientId: payload.clientId,
      exportId: payload.exportId,
      error: GENERIC_FAILURE_REASON,
    });
    return;
  }

  await deps.complete(client, {
    clientId: payload.clientId,
    exportId: payload.exportId,
    result,
  });
}
