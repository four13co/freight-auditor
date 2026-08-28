import type pg from 'pg';
import { deriveClaimStatus, type DeriveClaimStatusResult } from './derive-claim-status.js';

export class GetDerivedClaimStatusError extends Error {
  constructor(readonly code: 'CLAIM_NOT_FOUND') {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'GetDerivedClaimStatusError';
  }
}

interface ClaimStatusRow {
  status: string;
}

interface TerminalEventRow {
  event: string;
  recorded_at: Date;
}

interface RecoveryAmountRow {
  amount_recovered: string;
}

/**
 * Reads a claim's stored status, terminal audit_event history, and
 * recovery_event amounts, then derives what its status should be
 * (derive-claim-status.ts). Read-only; RLS-scoped via the caller's
 * withTenantTx, same "silently zero rows, never an error until this
 * wrapper's own not-found check" convention as list-findings.ts.
 */
export async function getDerivedClaimStatus(
  client: pg.PoolClient,
  clientId: string,
  claimId: string,
): Promise<DeriveClaimStatusResult> {
  const claimResult = await client.query<ClaimStatusRow>(
    `SELECT status FROM claim WHERE client_id = $1 AND id = $2`,
    [clientId, claimId],
  );
  const claim = claimResult.rows[0];
  if (!claim) throw new GetDerivedClaimStatusError('CLAIM_NOT_FOUND');

  const terminalEventsResult = await client.query<TerminalEventRow>(
    `SELECT event, recorded_at FROM audit_event
     WHERE client_id = $1 AND entity = 'claim' AND entity_id = $2
       AND event IN ('claim.recovered', 'claim.denied', 'claim.written_off')`,
    [clientId, claimId],
  );

  const recoveryEventsResult = await client.query<RecoveryAmountRow>(
    `SELECT amount_recovered FROM recovery_event WHERE client_id = $1 AND claim_id = $2`,
    [clientId, claimId],
  );

  return deriveClaimStatus({
    storedStatus: claim.status,
    terminalEvents: terminalEventsResult.rows.map((row) => ({ event: row.event, recordedAt: row.recorded_at })),
    recoveryEvents: recoveryEventsResult.rows.map((row) => ({ amountRecovered: row.amount_recovered })),
  });
}
