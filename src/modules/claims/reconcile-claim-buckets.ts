import { Decimal } from 'decimal.js';
import { isClaimTerminalStatus } from './claim-status.js';

/**
 * Shared currency-bucketing + reconciliation accumulation, extracted from
 * aggregate-cross-client-portfolio.ts, aggregate-carrier-recovery.ts, and
 * reconcile-portfolio-totals.ts (86e32tg28) -- their originating PRs
 * (#202, #201, #204) all merged, so the "deliberately self-contained"
 * duplication those files' docstrings cited no longer applies (same
 * retirement PR #213 already gave the terminal-status vocabulary).
 *
 * Callers keep their own grouping key (clientId+currency, carrierId+
 * currency, or currency alone) and their own output shape; only the
 * per-claim currency-splitting and terminal-status bucketing math lives
 * here, since that's what was byte-identical across all three.
 */
export interface ReconcilableClaimRow {
  claimId: string;
  amountClaimed: string;
  currency: string | null;
  status: string;
}

export interface ReconcilableRecoveryEventRow {
  claimId: string;
  amountRecovered: string;
  currency: string | null;
}

export interface ClaimReconciliationAccumulator {
  claimed: Decimal;
  recovered: Decimal;
  outstanding: Decimal;
  writtenOff: Decimal;
  denied: Decimal;
  nullCurrencyRecovered: Decimal;
  mismatchedCurrencyRecovered: Decimal;
}

export interface ClaimReconciliationTotals {
  claimed: string;
  recovered: string;
  outstanding: string;
  writtenOff: string;
  denied: string;
  /** recovery_event rows whose currency was NULL -- excluded from `recovered`, surfaced here instead. */
  nullCurrencyRecovered: string;
  /** recovery_event rows whose currency did not match their claim's own currency -- excluded from `recovered`, surfaced here instead. */
  mismatchedCurrencyRecovered: string;
}

export function emptyClaimReconciliationAccumulator(): ClaimReconciliationAccumulator {
  return {
    claimed: new Decimal(0),
    recovered: new Decimal(0),
    outstanding: new Decimal(0),
    writtenOff: new Decimal(0),
    denied: new Decimal(0),
    nullCurrencyRecovered: new Decimal(0),
    mismatchedCurrencyRecovered: new Decimal(0),
  };
}

/** Folds one claim + its recovery events into `bucket`, in place. */
export function accumulateClaimReconciliation(
  bucket: ClaimReconciliationAccumulator,
  claim: ReconcilableClaimRow,
  events: readonly ReconcilableRecoveryEventRow[],
): void {
  const claimed = new Decimal(claim.amountClaimed);
  bucket.claimed = bucket.claimed.plus(claimed);

  let sameCurrencyRecovered = new Decimal(0);
  for (const event of events) {
    const amount = new Decimal(event.amountRecovered);
    if (event.currency === null) {
      bucket.nullCurrencyRecovered = bucket.nullCurrencyRecovered.plus(amount);
    } else if (claim.currency !== null && event.currency !== claim.currency) {
      bucket.mismatchedCurrencyRecovered = bucket.mismatchedCurrencyRecovered.plus(amount);
    } else {
      sameCurrencyRecovered = sameCurrencyRecovered.plus(amount);
    }
  }
  bucket.recovered = bucket.recovered.plus(sameCurrencyRecovered);

  if (isClaimTerminalStatus(claim.status)) {
    switch (claim.status) {
      case 'recovered':
        // fully recovered: outstanding/writtenOff/denied stay 0 for this claim
        break;
      case 'denied':
        bucket.denied = bucket.denied.plus(claimed).minus(sameCurrencyRecovered);
        break;
      case 'written_off':
        bucket.writtenOff = bucket.writtenOff.plus(claimed).minus(sameCurrencyRecovered);
        break;
    }
  } else {
    bucket.outstanding = bucket.outstanding.plus(claimed).minus(sameCurrencyRecovered);
  }
}

export function finalizeClaimReconciliationTotals(bucket: ClaimReconciliationAccumulator): ClaimReconciliationTotals {
  return {
    claimed: bucket.claimed.toFixed(4),
    recovered: bucket.recovered.toFixed(4),
    outstanding: bucket.outstanding.toFixed(4),
    writtenOff: bucket.writtenOff.toFixed(4),
    denied: bucket.denied.toFixed(4),
    nullCurrencyRecovered: bucket.nullCurrencyRecovered.toFixed(4),
    mismatchedCurrencyRecovered: bucket.mismatchedCurrencyRecovered.toFixed(4),
  };
}

/** claimed == recovered + outstanding + writtenOff + denied, using only same-currency recovered amounts. */
export function claimReconciliationReconciles(bucket: ClaimReconciliationAccumulator): boolean {
  return bucket.claimed.equals(bucket.recovered.plus(bucket.outstanding).plus(bucket.writtenOff).plus(bucket.denied));
}
