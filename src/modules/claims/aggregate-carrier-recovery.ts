import { Decimal } from 'decimal.js';

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

const TERMINAL_RECOVERED = 'recovered';
const TERMINAL_DENIED = 'denied';
const TERMINAL_WRITTEN_OFF = 'written_off';

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

  interface Accumulator {
    carrierId: string | null; currency: string | null;
    claimed: Decimal; recovered: Decimal; outstanding: Decimal; writtenOff: Decimal; denied: Decimal;
    nullCurrencyRecovered: Decimal; mismatchedCurrencyRecovered: Decimal;
  }
  const buckets = new Map<string, Accumulator>();

  function bucketFor(carrierId: string | null, currency: string | null): Accumulator {
    const key = `${carrierId ?? ' '}::${currency ?? ' '}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        carrierId, currency,
        claimed: new Decimal(0), recovered: new Decimal(0), outstanding: new Decimal(0), writtenOff: new Decimal(0), denied: new Decimal(0),
        nullCurrencyRecovered: new Decimal(0), mismatchedCurrencyRecovered: new Decimal(0),
      };
      buckets.set(key, bucket);
    }
    return bucket;
  }

  for (const claim of claims) {
    const bucket = bucketFor(claim.carrierId, claim.currency);
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

  return [...buckets.values()].map((b) => ({
    carrierId: b.carrierId,
    currency: b.currency,
    claimed: b.claimed.toFixed(4),
    recovered: b.recovered.toFixed(4),
    outstanding: b.outstanding.toFixed(4),
    writtenOff: b.writtenOff.toFixed(4),
    denied: b.denied.toFixed(4),
    nullCurrencyRecovered: b.nullCurrencyRecovered.toFixed(4),
    mismatchedCurrencyRecovered: b.mismatchedCurrencyRecovered.toFixed(4),
  }));
}
