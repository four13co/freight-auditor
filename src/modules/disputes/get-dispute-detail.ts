import type pg from 'pg';

export interface DisputeLineRow {
  id: string;
  varianceFindingId: string | null;
  amount: string | null;
  currency: string | null;
}

export interface DisputeDetail {
  id: string;
  carrierId: string | null;
  status: string;
  amountClaimed: string | null;
  currency: string | null;
  createdAt: Date;
  lines: DisputeLineRow[];
}

/**
 * Fetches one dispute plus its dispute_line rows (P4.C.6). Returns null
 * when the dispute doesn't exist or isn't visible under RLS for this
 * tenant -- the caller maps that to 404, matching get-claim-detail.ts's
 * (P5.B.4/#181, merged) `null` convention for the same "doesn't exist" vs
 * "not yours" ambiguity.
 *
 * Deliberately does NOT include #173's evidence prose: that module is
 * open/unmerged and a pure function with no persistence, and its inputs
 * (citations) come from #172/#170, also unmerged. Lines + amounts +
 * currency is the reviewable surface for this item; prose narration is a
 * later additive slice, not a dependency of this one.
 */
export async function getDisputeDetail(client: pg.PoolClient, disputeId: string): Promise<DisputeDetail | null> {
  const { rows: disputeRows } = await client.query<{
    id: string; carrier_id: string | null; status: string; amount_claimed: string | null;
    currency: string | null; created_at: Date;
  }>(
    `SELECT id, carrier_id, status::text AS status, amount_claimed, currency, created_at FROM dispute WHERE id = $1`,
    [disputeId],
  );
  const disputeRow = disputeRows[0];
  if (!disputeRow) return null;

  const { rows: lineRows } = await client.query<{
    id: string; variance_finding_id: string | null; amount: string | null; currency: string | null;
  }>(
    `SELECT id, variance_finding_id, amount, currency FROM dispute_line WHERE dispute_id = $1 ORDER BY id`,
    [disputeId],
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
