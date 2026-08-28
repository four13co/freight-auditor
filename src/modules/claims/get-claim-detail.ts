import type pg from 'pg';
import { Decimal } from 'decimal.js';

export interface RecoveryEventRow {
  id: string;
  amountRecovered: string;
  currency: string | null;
  varianceFindingId: string | null;
  recordedAt: Date;
}

export interface ClaimDetail {
  id: string;
  disputeId: string | null;
  amountClaimed: string;
  currency: string | null;
  status: string;
  openedAt: Date;
  agingDeadlineAt: Date | null;
  recoveryEvents: RecoveryEventRow[];
  cumulativeRecovered: string;
}

/**
 * Fetches one claim plus its full recovery_event history (P5.B.4). Returns
 * null when the claim doesn't exist or isn't visible under RLS -- the
 * caller maps that to 404, matching update-finding-status.ts's `found:
 * false` convention for the same ambiguity ("doesn't exist" vs "not
 * yours" are indistinguishable and MUST stay that way for a cross-tenant
 * request).
 */
export async function getClaimDetail(client: pg.PoolClient, claimId: string): Promise<ClaimDetail | null> {
  const { rows: claimRows } = await client.query<{
    id: string; dispute_id: string | null; amount_claimed: string; currency: string | null;
    status: string; opened_at: Date; aging_deadline_at: Date | null;
  }>(
    `SELECT id, dispute_id, amount_claimed, currency, status, opened_at, aging_deadline_at FROM claim WHERE id = $1`,
    [claimId],
  );
  const claimRow = claimRows[0];
  if (!claimRow) return null;

  const { rows: eventRows } = await client.query<{
    id: string; amount_recovered: string; currency: string | null; variance_finding_id: string | null; recorded_at: Date;
  }>(
    `SELECT id, amount_recovered, currency, variance_finding_id, recorded_at
       FROM recovery_event WHERE claim_id = $1 ORDER BY recorded_at ASC`,
    [claimId],
  );

  const cumulativeRecovered = eventRows
    .reduce((sum, r) => sum.plus(new Decimal(r.amount_recovered)), new Decimal(0))
    .toFixed(4);

  return {
    id: claimRow.id, disputeId: claimRow.dispute_id, amountClaimed: claimRow.amount_claimed,
    currency: claimRow.currency, status: claimRow.status, openedAt: claimRow.opened_at,
    agingDeadlineAt: claimRow.aging_deadline_at,
    recoveryEvents: eventRows.map((r) => ({
      id: r.id, amountRecovered: r.amount_recovered, currency: r.currency,
      varianceFindingId: r.variance_finding_id, recordedAt: r.recorded_at,
    })),
    cumulativeRecovered,
  };
}
