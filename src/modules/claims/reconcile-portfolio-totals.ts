import {
  accumulateClaimReconciliation,
  claimReconciliationReconciles,
  emptyClaimReconciliationAccumulator,
  finalizeClaimReconciliationTotals,
  type ClaimReconciliationAccumulator,
} from './reconcile-claim-buckets.js';

/**
 * Pure reconciliation for portfolio-wide totals (P5.C.4). Buckets claim +
 * recovery_event data by currency only (never across currencies, per
 * #176's check-currency-consistency.ts lesson) -- one grouping level
 * coarser than #202/P5.C.1's aggregateCarrierRecovery, which buckets by
 * (carrierId, currency).
 *
 * The currency-bucketing/reconciliation math itself lives in
 * reconcile-claim-buckets.ts, shared with aggregate-cross-client-
 * portfolio.ts and aggregate-carrier-recovery.ts (86e32tg28) -- #202/#201
 * both merged since this module's original "deliberately not imported"
 * rationale was written, so that constraint no longer applies. Only the
 * grouping key (currency alone) and output shape are specific here.
 *
 * Invariant every bucket satisfies: claimed == recovered + outstanding +
 * writtenOff + denied, using ONLY same-currency recovered amounts --
 * surfaced explicitly as `reconciles` rather than left for a caller to
 * re-derive, since that boolean is the entire point of a "reconcile
 * totals" item.
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

export interface PortfolioReconciliationBucket {
  currency: string | null;
  claimed: string;
  recovered: string;
  outstanding: string;
  writtenOff: string;
  denied: string;
  /** recovery_event rows whose currency was NULL -- excluded from `recovered`, surfaced here instead. */
  nullCurrencyRecovered: string;
  /** recovery_event rows whose currency did not match their claim's own currency -- excluded from `recovered`, surfaced here instead. */
  mismatchedCurrencyRecovered: string;
  /** claimed == recovered + outstanding + writtenOff + denied for this currency (same-currency amounts only). */
  reconciles: boolean;
}

export function reconcilePortfolioTotals(
  claims: readonly ReconcilableClaimRow[],
  recoveryEvents: readonly ReconcilableRecoveryEventRow[],
): PortfolioReconciliationBucket[] {
  const eventsByClaim = new Map<string, ReconcilableRecoveryEventRow[]>();
  for (const event of recoveryEvents) {
    const list = eventsByClaim.get(event.claimId) ?? [];
    list.push(event);
    eventsByClaim.set(event.claimId, list);
  }

  interface Accumulator extends ClaimReconciliationAccumulator {
    currency: string | null;
  }
  const buckets = new Map<string, Accumulator>();

  function bucketFor(currency: string | null): Accumulator {
    const key = currency ?? ' ';
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { currency, ...emptyClaimReconciliationAccumulator() };
      buckets.set(key, bucket);
    }
    return bucket;
  }

  for (const claim of claims) {
    const bucket = bucketFor(claim.currency);
    accumulateClaimReconciliation(bucket, claim, eventsByClaim.get(claim.claimId) ?? []);
  }

  return [...buckets.values()].map((b) => ({
    currency: b.currency,
    ...finalizeClaimReconciliationTotals(b),
    reconciles: claimReconciliationReconciles(b),
  }));
}
