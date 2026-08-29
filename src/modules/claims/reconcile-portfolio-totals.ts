import { Decimal } from 'decimal.js';

/**
 * Pure reconciliation for portfolio-wide totals (P5.C.4). Buckets claim +
 * recovery_event data by currency only (never across currencies, per
 * #176's check-currency-consistency.ts lesson) -- one grouping level
 * coarser than #202/P5.C.1's aggregateCarrierRecovery, which buckets by
 * (carrierId, currency).
 *
 * The terminal-status bucketing rules here are the same ones #202
 * establishes (claim.status: 'open' | 'recovered' | 'denied' |
 * 'written_off', migrations/0008, no DB CHECK constraint) -- deliberately
 * NOT imported from #202's aggregate-carrier-recovery.ts, since #202 is an
 * open, unmerged PR whose survival isn't guaranteed (three PRs earlier
 * this session -- #163, #167, #168 -- were closed by Review and rebuilt).
 * Importing it would make this PR fail to compile against Development
 * today and orphan it if #202 is closed. This duplicates ~30 lines of
 * bucketing logic; a follow-up can collapse the two into one shared
 * module once #202 merges.
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

const TERMINAL_RECOVERED = 'recovered';
const TERMINAL_DENIED = 'denied';
const TERMINAL_WRITTEN_OFF = 'written_off';

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

  interface Accumulator {
    currency: string | null;
    claimed: Decimal; recovered: Decimal; outstanding: Decimal; writtenOff: Decimal; denied: Decimal;
    nullCurrencyRecovered: Decimal; mismatchedCurrencyRecovered: Decimal;
  }
  const buckets = new Map<string, Accumulator>();

  function bucketFor(currency: string | null): Accumulator {
    const key = currency ?? ' ';
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        currency,
        claimed: new Decimal(0), recovered: new Decimal(0), outstanding: new Decimal(0), writtenOff: new Decimal(0), denied: new Decimal(0),
        nullCurrencyRecovered: new Decimal(0), mismatchedCurrencyRecovered: new Decimal(0),
      };
      buckets.set(key, bucket);
    }
    return bucket;
  }

  for (const claim of claims) {
    const bucket = bucketFor(claim.currency);
    const claimed = new Decimal(claim.amountClaimed);
    bucket.claimed = bucket.claimed.plus(claimed);

    let sameCurrencyRecovered = new Decimal(0);
    for (const event of eventsByClaim.get(claim.claimId) ?? []) {
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

    if (claim.status === TERMINAL_RECOVERED) {
      // fully recovered: outstanding/writtenOff/denied stay 0 for this claim
    } else if (claim.status === TERMINAL_DENIED) {
      bucket.denied = bucket.denied.plus(claimed).minus(sameCurrencyRecovered);
    } else if (claim.status === TERMINAL_WRITTEN_OFF) {
      bucket.writtenOff = bucket.writtenOff.plus(claimed).minus(sameCurrencyRecovered);
    } else {
      bucket.outstanding = bucket.outstanding.plus(claimed).minus(sameCurrencyRecovered);
    }
  }

  return [...buckets.values()].map((b) => {
    const reconciles = b.claimed.equals(b.recovered.plus(b.outstanding).plus(b.writtenOff).plus(b.denied));
    return {
      currency: b.currency,
      claimed: b.claimed.toFixed(4),
      recovered: b.recovered.toFixed(4),
      outstanding: b.outstanding.toFixed(4),
      writtenOff: b.writtenOff.toFixed(4),
      denied: b.denied.toFixed(4),
      nullCurrencyRecovered: b.nullCurrencyRecovered.toFixed(4),
      mismatchedCurrencyRecovered: b.mismatchedCurrencyRecovered.toFixed(4),
      reconciles,
    };
  });
}
