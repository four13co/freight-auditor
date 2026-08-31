import { Decimal } from 'decimal.js';

/**
 * Pure validation over already-fetched, analyst-accepted variance_finding
 * rows (P4.C.1). A dispute is scoped to exactly one carrier and one
 * currency (this platform never pre-converts currency, §6), so a candidate
 * set spanning more than one of either is rejected rather than guessed at.
 *
 * UNDERCHARGE findings are excluded, not rejected: an undercharge is not a
 * claim against the carrier (the platform owes the carrier more, not the
 * reverse), so it has nothing to dispute. A candidate set of undercharge-only
 * findings is therefore treated the same as an empty set.
 */
export interface DisputableFindingRow {
  id: string;
  status: string;
  carrierId: string | null;
  currency: string | null;
  varianceAmount: string | null;
  direction: 'OVERCHARGE' | 'UNDERCHARGE' | 'INTEGRITY_ONLY' | null;
}

export interface ValidatedDispute {
  findingIds: string[];
  carrierId: string;
  currency: string;
  amountClaimed: string;
}

export class DisputableFindingsError extends Error {
  constructor(
    readonly code:
      | 'EMPTY_SET'
      | 'NOT_ACCEPTED'
      | 'MIXED_CARRIER'
      | 'MIXED_CURRENCY'
      | 'MISSING_CARRIER'
      | 'MISSING_AMOUNT',
  ) {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'DisputableFindingsError';
  }
}

export function validateDisputableFindings(rows: readonly DisputableFindingRow[]): ValidatedDispute {
  const claimable = rows.filter((r) => r.direction !== 'UNDERCHARGE');
  if (claimable.length === 0) throw new DisputableFindingsError('EMPTY_SET');

  for (const row of claimable) {
    if (row.status !== 'accepted') throw new DisputableFindingsError('NOT_ACCEPTED');
    if (!row.carrierId) throw new DisputableFindingsError('MISSING_CARRIER');
    if (row.varianceAmount === null || row.currency === null) throw new DisputableFindingsError('MISSING_AMOUNT');
  }

  const carrierIds = new Set(claimable.map((r) => r.carrierId));
  if (carrierIds.size > 1) throw new DisputableFindingsError('MIXED_CARRIER');

  const currencies = new Set(claimable.map((r) => r.currency));
  if (currencies.size > 1) throw new DisputableFindingsError('MIXED_CURRENCY');

  const amountClaimed = claimable
    .reduce((sum, r) => sum.plus(new Decimal(r.varianceAmount!)), new Decimal(0));

  return {
    findingIds: claimable.map((r) => r.id),
    carrierId: [...carrierIds][0]!,
    currency: [...currencies][0]!,
    amountClaimed: amountClaimed.toFixed(4),
  };
}
