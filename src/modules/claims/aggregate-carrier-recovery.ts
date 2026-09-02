import {
  accumulateClaimReconciliation,
  emptyClaimReconciliationAccumulator,
  finalizeClaimReconciliationTotals,
  type ClaimReconciliationAccumulator,
} from './reconcile-claim-buckets.js';

/**
 * Pure aggregation for carrier-level recovery reporting (P5.C.1). Buckets
 * claim + recovery_event data by (carrierId, currency) -- never across
 * currencies, mirroring #176's check-currency-consistency.ts lesson that a
 * cross-currency SUM is a data-integrity bug, not a convenience. Currency
 * here is always the CLAIM's currency (a claim has exactly one); a
 * recovery_event with a different or NULL currency is a data-integrity
 * concern surfaced via nullCurrencyRecovered/mismatchedCurrencyRecovered
 * rather than silently folded into the bucket total -- mirroring #176's
 * "surface it, never silently exclude" rule for nullCurrencyEventIds.
 *
 * Reconciliation model (verified against #174's terminal-status vocabulary
 * -- claim.status: 'open' | 'recovered' | 'denied' | 'written_off', no DB
 * CHECK constraint, migrations/0008):
 *   - 'recovered'   -> cumulativeRecovered == amountClaimed (#174's
 *                      FULL_RECOVERY_AMOUNT_MISMATCH guard enforces this
 *                      at write time), so outstanding/writtenOff/denied
 *                      are all 0 for this claim.
 *   - 'denied'      -> the claimed amount was never recovered and never
 *                      will be; tracked in its OWN bucket, not folded into
 *                      writtenOff -- a denial is a different outcome than
 *                      a deliberate write-off (#174 never writes a
 *                      recovery_event for a denial, so this is always the
 *                      full claimed amount in practice, but the subtraction
 *                      is kept for defense-in-depth against a future writer).
 *   - 'written_off' -> the unrecovered remainder (claimed - recovered) is
 *                      writtenOff; a write-off can follow a nonzero
 *                      partial recovery (#174), so this is NOT always the
 *                      full claimed amount.
 *   - 'open' (or any other non-terminal status) -> the unrecovered
 *                      remainder is outstanding, not yet resolved.
 *
 * Invariant every bucket satisfies: claimed == recovered + outstanding +
 * writtenOff + denied, using ONLY same-currency recovered amounts.
 * Asserted directly in this module's tests.
 *
 * The currency-bucketing/reconciliation math itself lives in
 * reconcile-claim-buckets.ts, shared with aggregate-cross-client-
 * portfolio.ts and reconcile-portfolio-totals.ts (86e32tg28) -- only the
 * grouping key (carrierId+currency) and output shape are specific here.
 */
export interface CarrierClaimRow {
  carrierId: string | null;
  claimId: string;
  amountClaimed: string;
  currency: string | null;
  status: string;
}

export interface CarrierRecoveryEventRow {
  claimId: string;
  amountRecovered: string;
  currency: string | null;
}

export interface CarrierRecoveryBucket {
  carrierId: string | null;
  currency: string | null;
  claimed: string;
  recovered: string;
  outstanding: string;
  writtenOff: string;
  denied: string;
  /** recovery_event rows for this bucket's claims whose currency was NULL -- excluded from `recovered`, surfaced here instead. */
  nullCurrencyRecovered: string;
  /** recovery_event rows for this bucket's claims whose currency did not match the claim's own currency -- excluded from `recovered`, surfaced here instead. */
  mismatchedCurrencyRecovered: string;
}

export function aggregateCarrierRecovery(
  claims: readonly CarrierClaimRow[],
  recoveryEvents: readonly CarrierRecoveryEventRow[],
): CarrierRecoveryBucket[] {
  const eventsByClaim = new Map<string, CarrierRecoveryEventRow[]>();
  for (const event of recoveryEvents) {
    const list = eventsByClaim.get(event.claimId) ?? [];
    list.push(event);
    eventsByClaim.set(event.claimId, list);
  }

  interface Accumulator extends ClaimReconciliationAccumulator {
    carrierId: string | null;
    currency: string | null;
  }
  const buckets = new Map<string, Accumulator>();

  function bucketFor(carrierId: string | null, currency: string | null): Accumulator {
    const key = `${carrierId ?? ' '}::${currency ?? ' '}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { carrierId, currency, ...emptyClaimReconciliationAccumulator() };
      buckets.set(key, bucket);
    }
    return bucket;
  }

  for (const claim of claims) {
    const bucket = bucketFor(claim.carrierId, claim.currency);
    accumulateClaimReconciliation(bucket, claim, eventsByClaim.get(claim.claimId) ?? []);
  }

  return [...buckets.values()].map((b) => ({
    carrierId: b.carrierId,
    currency: b.currency,
    ...finalizeClaimReconciliationTotals(b),
  }));
}
