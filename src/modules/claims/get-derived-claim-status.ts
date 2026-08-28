import type pg from 'pg';
import { deriveClaimStatus, type DerivedClaimStatus } from './derive-claim-status.js';

export class GetDerivedClaimStatusError extends Error {
  constructor(readonly code: 'CLAIM_NOT_FOUND') {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'GetDerivedClaimStatusError';
  }
}

/**
 * Reconciliation read for one claim (P5.A.5): fetches the claim's
 * audit_event history (entity = 'claim', entity_id = claimId) and its
 * recovery_event total, then compares the derived status against what is
 * actually stored on claim.status. Read-only -- never writes a correction;
 * a mismatch is a finding for the caller (or a later reconciliation item,
 * P5.C.4) to act on, not something this function resolves itself.
 */
export async function getDerivedClaimStatus(
  client: pg.PoolClient,
  clientId: string,
  claimId: string,
): Promise<DerivedClaimStatus> {
  const { rows: claimRows } = await client.query<{ status: string }>(
    `SELECT status FROM claim WHERE client_id = $1 AND id = $2`,
    [clientId, claimId],
  );
  const claimRow = claimRows[0];
  if (!claimRow) throw new GetDerivedClaimStatusError('CLAIM_NOT_FOUND');

  const { rows: eventRows } = await client.query<{ event: string; recorded_at: string }>(
    `SELECT event, recorded_at FROM audit_event WHERE client_id = $1 AND entity = 'claim' AND entity_id = $2`,
    [clientId, claimId],
  );

  const { rows: recoveryRows } = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_recovered), 0)::text AS total FROM recovery_event WHERE client_id = $1 AND claim_id = $2`,
    [clientId, claimId],
  );

  return deriveClaimStatus(
    claimId,
    eventRows.map((r) => ({ event: r.event, recordedAt: r.recorded_at })),
    recoveryRows[0]!.total,
    claimRow.status,
  );
}
