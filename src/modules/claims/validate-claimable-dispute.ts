import { Decimal } from 'decimal.js';

/**
 * Pure validation over an already-fetched dispute row (P5.A.1). A claim can
 * only be opened against a dispute the carrier has accepted (dispute_status
 * 'accepted', see migrations/0002_enums.sql) and that carries a concrete,
 * positive claimed amount and currency -- both already populated by dispute
 * creation (P4.C.1).
 *
 * "Already claimed" here means THIS dispute already has an open/settled
 * claim row against it (a retry/duplicate-call boundary for this dispute).
 * Preventing two DIFFERENT disputes from double-counting the same recovered
 * dollars is P5.A.2's boundary ("prevent duplicate claimed amounts"), not
 * solved here.
 */
export interface ClaimableDisputeRow {
  id: string;
  status: string;
  amountClaimed: string | null;
  currency: string | null;
}

export interface ValidatedClaimableDispute {
  disputeId: string;
  amountClaimed: string;
  currency: string;
}

export class ClaimableDisputeError extends Error {
  constructor(
    readonly code:
      | 'NOT_ACCEPTED'
      | 'MISSING_AMOUNT'
      | 'MISSING_CURRENCY'
      | 'NON_POSITIVE_AMOUNT'
      | 'ALREADY_CLAIMED',
  ) {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'ClaimableDisputeError';
  }
}

export function validateClaimableDispute(
  row: ClaimableDisputeRow,
  opts: { alreadyClaimed?: boolean } = {},
): ValidatedClaimableDispute {
  if (opts.alreadyClaimed) throw new ClaimableDisputeError('ALREADY_CLAIMED');
  if (row.status !== 'accepted') throw new ClaimableDisputeError('NOT_ACCEPTED');
  if (row.amountClaimed === null) throw new ClaimableDisputeError('MISSING_AMOUNT');
  if (row.currency === null) throw new ClaimableDisputeError('MISSING_CURRENCY');
  if (new Decimal(row.amountClaimed).lte(0)) throw new ClaimableDisputeError('NON_POSITIVE_AMOUNT');

  return {
    disputeId: row.id,
    amountClaimed: row.amountClaimed,
    currency: row.currency,
  };
}
