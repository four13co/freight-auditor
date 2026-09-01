import { Decimal } from 'decimal.js';

/**
 * Pure aggregation for cross-client portfolio reporting (P5.C.3). Buckets
 * claim + recovery_event data by (clientId, currency) -- never across
 * currencies, mirroring #176's check-currency-consistency.ts lesson (also
 * followed by aggregate-carrier-recovery.ts/P5.C.1 and
 * reconcile-portfolio-totals.ts/P5.C.4). This is the cross-client sibling of
 * reconcile-portfolio-totals.ts: same bucketing/reconciliation math, one
 * extra grouping key (clientId) since the caller here spans every client
 * rather than one tenant's own rows.
 *
 * Deliberately self-contained (no shared import with aggregate-carrier-
 * recovery.ts or reconcile-portfolio-totals.ts) for the same reason those
 * two give for not importing each other: this compiles and is testable
 * against Development today with no dependency on any other open PR
 * surviving review.
 *
 * clientId is never null here (claim.client_id is NOT NULL, migrations/0008),
 * unlike aggregate-carrier-recovery.ts's carrierId (dispute.carrier_id is
 * nullable via the LEFT JOIN there).
 */
export interface ClientPortfolioClaimRow {
  clientId: string;
  clientName: string | null;
  claimId: string;
  amountClaimed: string;
  currency: string | null;
  status: string;
}

export interface ClientPortfolioRecoveryEventRow {
  claimId: string;
  amountRecovered: string;
  currency: string | null;
}

export interface ClientPortfolioBucket {
  clientId: string;
  clientName: string | null;
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
  /** claimed == recovered + outstanding + writtenOff + denied for this bucket (same-currency amounts only). */
  reconciles: boolean;
}

const TERMINAL_RECOVERED = 'recovered';
const TERMINAL_DENIED = 'denied';
const TERMINAL_WRITTEN_OFF = 'written_off';

export function aggregateCrossClientPortfolio(
  claims: readonly ClientPortfolioClaimRow[],
  recoveryEvents: readonly ClientPortfolioRecoveryEventRow[],
): ClientPortfolioBucket[] {
  const eventsByClaim = new Map<string, ClientPortfolioRecoveryEventRow[]>();
  for (const event of recoveryEvents) {
    const list = eventsByClaim.get(event.claimId) ?? [];
    list.push(event);
    eventsByClaim.set(event.claimId, list);
  }

  interface Accumulator {
    clientId: string; clientName: string | null; currency: string | null;
    claimed: Decimal; recovered: Decimal; outstanding: Decimal; writtenOff: Decimal; denied: Decimal;
    nullCurrencyRecovered: Decimal; mismatchedCurrencyRecovered: Decimal;
  }
  const buckets = new Map<string, Accumulator>();

  function bucketFor(clientId: string, clientName: string | null, currency: string | null): Accumulator {
    const key = `${clientId}::${currency ?? ' '}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        clientId, clientName, currency,
        claimed: new Decimal(0), recovered: new Decimal(0), outstanding: new Decimal(0), writtenOff: new Decimal(0), denied: new Decimal(0),
        nullCurrencyRecovered: new Decimal(0), mismatchedCurrencyRecovered: new Decimal(0),
      };
      buckets.set(key, bucket);
    }
    return bucket;
  }

  for (const claim of claims) {
    const bucket = bucketFor(claim.clientId, claim.clientName, claim.currency);
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
      clientId: b.clientId,
      clientName: b.clientName,
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
