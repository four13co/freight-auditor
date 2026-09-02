import type pg from 'pg';

export interface ClientDisputeLineRow {
  id: string;
  varianceFindingId: string | null;
  amount: string | null;
  currency: string | null;
}

export interface ClientDisputeDetail {
  id: string;
  carrierId: string | null;
  status: string;
  amountClaimed: string | null;
  currency: string | null;
  createdAt: Date;
  lines: ClientDisputeLineRow[];
}

/**
 * Client portal (P6.B.3) equivalent of the internal getDisputeDetail
 * (../disputes/get-dispute-detail.ts): same join shape (dispute +
 * dispute_line), with an added explicit `client_id` predicate on both
 * queries (86e31a9ch/#216 precedent: on top of RLS, not a replacement for
 * it) -- the internal function relies on RLS alone (no clientId param at
 * all), which is fine for its own tenant-scoped analyst callers but not the
 * pattern this portal surface follows elsewhere (list-client-invoices.ts,
 * get-client-audit-run-scorecard.ts, list-client-findings.ts).
 *
 * Returns null when the dispute doesn't exist or isn't visible to this
 * clientId -- doesn't distinguish "doesn't exist" from "belongs to another
 * client", matching get-dispute-detail.ts's own not-found convention.
 */
export async function getClientDisputeDetail(
  client: pg.PoolClient,
  clientId: string,
  disputeId: string,
): Promise<ClientDisputeDetail | null> {
  const { rows: disputeRows } = await client.query<{
    id: string; carrier_id: string | null; status: string; amount_claimed: string | null;
    currency: string | null; created_at: Date;
  }>(
    `SELECT id, carrier_id, status::text AS status, amount_claimed, currency, created_at
       FROM dispute WHERE id = $1 AND client_id = $2`,
    [disputeId, clientId],
  );
  const disputeRow = disputeRows[0];
  if (!disputeRow) return null;

  const { rows: lineRows } = await client.query<{
    id: string; variance_finding_id: string | null; amount: string | null; currency: string | null;
  }>(
    `SELECT id, variance_finding_id, amount, currency
       FROM dispute_line WHERE dispute_id = $1 AND client_id = $2 ORDER BY id`,
    [disputeId, clientId],
  );

  return {
    id: disputeRow.id,
    carrierId: disputeRow.carrier_id,
    status: disputeRow.status,
    amountClaimed: disputeRow.amount_claimed,
    currency: disputeRow.currency,
    createdAt: disputeRow.created_at,
    lines: lineRows.map((r) => ({
      id: r.id, varianceFindingId: r.variance_finding_id, amount: r.amount, currency: r.currency,
    })),
  };
}
