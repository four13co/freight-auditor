import { Decimal } from 'decimal.js';
import { validateRecoveryAmountAndCurrency } from './validate-recovery-amount-and-currency.js';

/**
 * Pure validation for recording a partial recovery event against a claim
 * (P5.A.3). recovery_event is append-only (0010) and already supports
 * multiple rows per claim_id -- "partial" just means the cumulative
 * recovered amount across all of a claim's recovery_event rows can be less
 * than claim.amount_claimed at any point, accumulating toward it over
 * several events rather than requiring one final full-amount row.
 *
 * A single event's amount must be positive (a zero or negative "recovery"
 * isn't a recovery) and the NEW cumulative total (prior recovered + this
 * event) must not exceed the claim's amount_claimed -- recovering more than
 * was claimed is a data error this platform refuses to record silently.
 */
export interface ClaimRow {
  id: string;
  amountClaimed: string;
  currency: string | null;
}

export interface ValidatedPartialRecovery {
  claimId: string;
  amountRecovered: string;
  currency: string;
  cumulativeRecovered: string;
  isFinal: boolean;
}

export class PartialRecoveryError extends Error {
  constructor(
    readonly code:
      | 'NON_POSITIVE_AMOUNT'
      | 'MISSING_CURRENCY'
      | 'MIXED_CURRENCY'
      | 'EXCEEDS_CLAIMED_AMOUNT',
  ) {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'PartialRecoveryError';
  }
}

export function validatePartialRecovery(
  claim: ClaimRow,
  amountRecovered: string,
  currency: string | null,
  priorRecoveredTotal: string,
): ValidatedPartialRecovery {
  const validated = validateRecoveryAmountAndCurrency(amountRecovered, currency, claim.currency, {
    onNonPositiveAmount: () => { throw new PartialRecoveryError('NON_POSITIVE_AMOUNT'); },
    onMissingCurrency: () => { throw new PartialRecoveryError('MISSING_CURRENCY'); },
    onMixedCurrency: () => { throw new PartialRecoveryError('MIXED_CURRENCY'); },
  });

  const cumulative = new Decimal(priorRecoveredTotal).plus(validated.amount);
  if (cumulative.gt(new Decimal(claim.amountClaimed))) throw new PartialRecoveryError('EXCEEDS_CLAIMED_AMOUNT');

  return {
    claimId: claim.id,
    amountRecovered: validated.amount,
    currency: validated.currency,
    cumulativeRecovered: cumulative.toFixed(4),
    isFinal: cumulative.eq(new Decimal(claim.amountClaimed)),
  };
}
