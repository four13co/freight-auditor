import {
  accumulateClaimReconciliation,
  claimReconciliationReconciles,
  emptyClaimReconciliationAccumulator,
  finalizeClaimReconciliationTotals,
  type ClaimReconciliationAccumulator,
} from './reconcile-claim-buckets.js';

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
 * The currency-bucketing/reconciliation math itself lives in
 * reconcile-claim-buckets.ts, shared with aggregate-carrier-recovery.ts and
 * reconcile-portfolio-totals.ts (86e32tg28) -- only the grouping key
 * (clientId+currency) and output shape (clientName, reconciles) are
 * specific to this module.
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

  interface Accumulator extends ClaimReconciliationAccumulator {
    clientId: string;
    clientName: string | null;
    currency: string | null;
  }
  const buckets = new Map<string, Accumulator>();

  function bucketFor(clientId: string, clientName: string | null, currency: string | null): Accumulator {
    const key = `${clientId}::${currency ?? ' '}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { clientId, clientName, currency, ...emptyClaimReconciliationAccumulator() };
      buckets.set(key, bucket);
    }
    return bucket;
  }

  for (const claim of claims) {
    const bucket = bucketFor(claim.clientId, claim.clientName, claim.currency);
    accumulateClaimReconciliation(bucket, claim, eventsByClaim.get(claim.claimId) ?? []);
  }

  return [...buckets.values()].map((b) => ({
    clientId: b.clientId,
    clientName: b.clientName,
    currency: b.currency,
    ...finalizeClaimReconciliationTotals(b),
    reconciles: claimReconciliationReconciles(b),
  }));
}
