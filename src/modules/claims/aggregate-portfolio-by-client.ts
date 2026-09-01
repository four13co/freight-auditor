import { Decimal } from 'decimal.js';

/**
 * Pure aggregation for cross-client portfolio reporting (P5.C.3). Buckets
 * claim + recovery_event data by (clientId, currency) -- never across
 * currencies, mirroring #176's check-currency-consistency.ts lesson and the
 * identical rule already applied by aggregate-carrier-recovery.ts (bucketed
 * by carrierId) and reconcile-portfolio-totals.ts (single-client, bucketed
 * by currency only). This is the cross-tenant sibling of both: every client
 * in the tenant's portfolio, side by side, for an internal analyst -- the
 * caller is responsible for having fetched claims across every client (via
 * an internal-scoped transaction; see get-cross-client-portfolio-report.ts),
 * this module only buckets what it's handed.
 *
 * Reconciliation model, terminal-status vocabulary, and the
 * nullCurrencyRecovered/mismatchedCurrencyRecovered surfacing are unchanged
 * from aggregate-carrier-recovery.ts -- see that module's doc comment for
 * the full rationale. Duplicated rather than imported for the same reason
 * reconcile-portfolio-totals.ts duplicates it: these are independently
 * reviewable PRs and importing across them risks orphaning this one if a
 * sibling is closed and rebuilt.
 *
 * Invariant every bucket satisfies: claimed == recovered + outstanding +
 * writtenOff + denied, using ONLY same-currency recovered amounts.
 */
export interface PortfolioClaimRow {
  clientId: string;
  clientName: string;
  claimId: string;
  amountClaimed: string;
  currency: string | null;
  status: string;
}

export interface PortfolioRecoveryEventRow {
  claimId: string;
  amountRecovered: string;
  currency: string | null;
}

export interface ClientPortfolioBucket {
  clientId: string;
  clientName: string;
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

export function aggregatePortfolioByClient(
  claims: readonly PortfolioClaimRow[],
  recoveryEvents: readonly PortfolioRecoveryEventRow[],
): ClientPortfolioBucket[] {
  const eventsByClaim = new Map<string, PortfolioRecoveryEventRow[]>();
  for (const event of recoveryEvents) {
    const list = eventsByClaim.get(event.claimId) ?? [];
    list.push(event);
    eventsByClaim.set(event.claimId, list);
  }

  interface Accumulator {
    clientId: string; clientName: string; currency: string | null;
    claimed: Decimal; recovered: Decimal; outstanding: Decimal; writtenOff: Decimal; denied: Decimal;
    nullCurrencyRecovered: Decimal; mismatchedCurrencyRecovered: Decimal;
  }
  const buckets = new Map<string, Accumulator>();

  function bucketFor(clientId: string, clientName: string, currency: string | null): Accumulator {
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
