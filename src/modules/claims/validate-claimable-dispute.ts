import { validateRecoveryAmountAndCurrency } from './validate-recovery-amount-and-currency.js';

/**
 * Pure validation over an already-fetched dispute row (P5.A.1). A claim can
 * only be opened against a dispute the carrier has accepted (dispute_status
 * 'accepted', see migrations/0002_enums.sql) and that carries a concrete,
 * positive claimed amount and currency -- both already populated by dispute
 * creation (P4.C.1/#162).
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
      | 'NON_POSITIVE_AMOUNT',
  ) {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'ClaimableDisputeError';
  }
}

export function validateClaimableDispute(row: ClaimableDisputeRow): ValidatedClaimableDispute {
  if (row.status !== 'accepted') throw new ClaimableDisputeError('NOT_ACCEPTED');
  if (row.amountClaimed === null) throw new ClaimableDisputeError('MISSING_AMOUNT');
  if (row.currency === null) throw new ClaimableDisputeError('MISSING_CURRENCY');

  // existingCurrency: null -- a single dispute's own amount/currency, nothing
  // to compare against, so onMissingCurrency/onMixedCurrency are unreachable
  // here (currency is already proven non-null above, and there is no second
  // currency to mismatch against).
  const validated = validateRecoveryAmountAndCurrency(row.amountClaimed, row.currency, null, {
    onNonPositiveAmount: () => { throw new ClaimableDisputeError('NON_POSITIVE_AMOUNT'); },
    onMissingCurrency: () => { throw new Error('unreachable: currency already checked non-null'); },
    onMixedCurrency: () => { throw new Error('unreachable: no existingCurrency provided'); },
  });

  return {
    disputeId: row.id,
    amountClaimed: validated.amount,
    currency: validated.currency,
  };
}
