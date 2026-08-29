import type pg from 'pg';
import { checkCurrencyConsistency, type CurrencyConsistencyResult } from './check-currency-consistency.js';

export class GetClaimCurrencyConsistencyError extends Error {
  constructor(readonly code: 'CLAIM_NOT_FOUND') {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'GetClaimCurrencyConsistencyError';
  }
}

/**
 * Reconciliation read for one claim (P5.A.6): fetches the claim's currency
 * and every one of its recovery_event rows, then checks internal currency
 * consistency (check-currency-consistency.ts). Read-only -- never corrects
 * a mismatch, same convention as get-derived-claim-status.ts (P5.A.5/#175).
 */
export async function getClaimCurrencyConsistency(
  client: pg.PoolClient,
  clientId: string,
  claimId: string,
): Promise<CurrencyConsistencyResult> {
  const { rows: claimRows } = await client.query<{ currency: string | null }>(
    `SELECT currency FROM claim WHERE client_id = $1 AND id = $2`,
    [clientId, claimId],
  );
  const claimRow = claimRows[0];
  if (!claimRow) throw new GetClaimCurrencyConsistencyError('CLAIM_NOT_FOUND');

  const { rows: eventRows } = await client.query<{ id: string; currency: string | null }>(
    `SELECT id, currency FROM recovery_event WHERE client_id = $1 AND claim_id = $2`,
    [clientId, claimId],
  );

  return checkCurrencyConsistency(claimId, claimRow.currency, eventRows);
}
