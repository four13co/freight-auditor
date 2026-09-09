import type pg from 'pg';
import { z } from 'zod';
import { reconcilePortfolioTotals, type PortfolioReconciliationBucket } from './reconcile-portfolio-totals.js';

const schema = z.object({
  clientId: z.uuid(),
}).strict();

/**
 * Portfolio-wide reconciliation (P5.C.4): fetches this tenant's claims plus
 * their full recovery_event history and hands both to the pure
 * reconcilePortfolioTotals for the actual bucketing/reconciliation math.
 * Query shape mirrors #202/P5.C.1's get-carrier-recovery-report.ts, minus
 * the carrier join and carrierId scoping -- this item groups by currency
 * only, across every carrier, not per-carrier.
 *
 * reconcile-portfolio-totals.ts (in turn) imports its shared
 * currency-bucketing/reconciliation math from reconcile-claim-buckets.ts
 * (86e32tg28) -- the original "deliberately self-contained, no import from
 * #202's files" constraint no longer applies now that #202 has merged.
 */
export async function getPortfolioReconciliation(
  client: pg.PoolClient,
  untrusted: z.input<typeof schema>,
): Promise<PortfolioReconciliationBucket[]> {
  const input = schema.parse(untrusted);

  const { rows: claimRows } = await client.query<{
    claim_id: string; amount_claimed: string; currency: string | null; status: string;
  }>(
    `SELECT id AS claim_id, amount_claimed, currency, status FROM claim WHERE client_id = $1`,
    [input.clientId],
  );

  if (claimRows.length === 0) return [];

  const claimIds = claimRows.map((r) => r.claim_id);
  const { rows: eventRows } = await client.query<{ claim_id: string; amount_recovered: string; currency: string | null }>(
    `SELECT claim_id, amount_recovered, currency FROM recovery_event WHERE client_id = $1 AND claim_id = ANY($2::uuid[])`,
    [input.clientId, claimIds],
  );

  return reconcilePortfolioTotals(
    claimRows.map((r) => ({ claimId: r.claim_id, amountClaimed: r.amount_claimed, currency: r.currency, status: r.status })),
    eventRows.map((r) => ({ claimId: r.claim_id, amountRecovered: r.amount_recovered, currency: r.currency })),
  );
}
