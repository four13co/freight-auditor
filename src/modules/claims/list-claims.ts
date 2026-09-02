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
  /**
   * Keyset position (P6.C.1): resume after this row. Only `id` is used --
   * NOT a timestamp round-tripped through the client, because node-pg's
   * timestamptz type parser truncates to millisecond precision while the
   * column itself holds microseconds, so a client-supplied timestamp can
   * silently under-represent a row and make an exact tie-break match fail
   * (observed directly: two rows created in the same transaction, hence
   * bit-identical opened_at, and a client-round-tripped cursor still failed
   * to match the second one). Instead the query re-reads this row's own
   * opened_at fresh from the DB via a correlated subquery, comparing
   * native timestamptz-to-timestamptz with no client round trip at all.
   */
  cursor?: { id: string };
}

const DEFAULT_LIMIT = 50;

/**
 * List claim rows for the given tenant scope. Sorted newest-first
 * (opened_at DESC, id ASC as a tiebreaker so ties can't drop or duplicate
 * rows across pages -- P6.C.1) -- no configurable sort key yet, unlike
 * listFindings, since no claims-specific sort requirement has surfaced.
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

  let fromClause = 'FROM claim';
  if (options.cursor) {
    params.push(options.cursor.id);
    const cursorIdIdx = params.length;
    // cursor_anchor re-reads the anchor row's OWN opened_at from the DB
    // (see ListClaimsOptions.cursor's comment for why) -- gated by the same
    // explicit client_id predicate as the outer query, not RLS alone.
    fromClause = `FROM claim, (
      SELECT opened_at AS anchor_opened_at, id AS anchor_id
        FROM claim AS cursor_row
       WHERE cursor_row.id = $${cursorIdIdx} AND cursor_row.client_id = $1
    ) cursor_anchor`;
    conditions.push('(opened_at < cursor_anchor.anchor_opened_at OR (opened_at = cursor_anchor.anchor_opened_at AND id > cursor_anchor.anchor_id))');
  }

  const limit = options.limit ?? DEFAULT_LIMIT;
  let limitOffsetClause: string;
  if (options.cursor) {
    params.push(limit);
    limitOffsetClause = `LIMIT $${params.length}`;
  } else {
    const offset = options.offset ?? 0;
    params.push(limit, offset);
    limitOffsetClause = `LIMIT $${params.length - 1} OFFSET $${params.length}`;
  }

  const { rows } = await client.query<{
    id: string; dispute_id: string | null; amount_claimed: string; currency: string | null;
    status: string; opened_at: Date; aging_deadline_at: Date | null;
  }>(
    `SELECT id, dispute_id, amount_claimed, currency, status, opened_at, aging_deadline_at
       ${fromClause}
      WHERE ${conditions.join(' AND ')}
      ORDER BY opened_at DESC, id ASC
      ${limitOffsetClause}`,
    params,
  );

  return rows.map((r) => ({
    id: r.id, disputeId: r.dispute_id, amountClaimed: r.amount_claimed, currency: r.currency,
    status: r.status, openedAt: r.opened_at, agingDeadlineAt: r.aging_deadline_at,
  }));
}
