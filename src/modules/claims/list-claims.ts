import type pg from 'pg';

/**
 * One row of the claims list (P5.B.4). Runs inside the caller's
 * withTenantTx -- RLS is FORCE-enabled on claim, so a query issued outside
 * that transaction silently returns zero rows, never an error, matching
 * list-findings.ts's own convention. `clientId` is an explicit predicate on
 * top of RLS, not a replacement for it -- see get-claim-detail.ts's header
 * comment for why (86e31a9ch/#216 precedent).
 */
export interface ClaimRow {
  id: string;
  disputeId: string | null;
  amountClaimed: string;
  currency: string | null;
  status: string;
  openedAt: Date;
  agingDeadlineAt: Date | null;
}

export interface ListClaimsOptions {
  status?: string;
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 50;

/**
 * List claim rows for the given tenant scope. Sorted newest-first
 * (opened_at DESC) -- no configurable sort key yet, unlike listFindings,
 * since no claims-specific sort requirement has surfaced.
 */
export async function listClaims(
  client: pg.PoolClient,
  clientId: string,
  options: ListClaimsOptions = {},
): Promise<ClaimRow[]> {
  const conditions: string[] = ['client_id = $1'];
  const params: unknown[] = [clientId];

  if (options.status) {
    params.push(options.status);
    conditions.push(`status = $${params.length}`);
  }

  const limit = options.limit ?? DEFAULT_LIMIT;
  const offset = options.offset ?? 0;

  params.push(limit, offset);
  const { rows } = await client.query<{
    id: string; dispute_id: string | null; amount_claimed: string; currency: string | null;
    status: string; opened_at: Date; aging_deadline_at: Date | null;
  }>(
    `SELECT id, dispute_id, amount_claimed, currency, status, opened_at, aging_deadline_at
       FROM claim
      WHERE ${conditions.join(' AND ')}
      ORDER BY opened_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return rows.map((r) => ({
    id: r.id, disputeId: r.dispute_id, amountClaimed: r.amount_claimed, currency: r.currency,
    status: r.status, openedAt: r.opened_at, agingDeadlineAt: r.aging_deadline_at,
  }));
}
