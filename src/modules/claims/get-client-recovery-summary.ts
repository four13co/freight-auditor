import type pg from 'pg';
import { Decimal } from 'decimal.js';

/**
 * Client-facing recovery summary (P5.C.2): the tenant's own view of their
 * overall recovery position, bucketed by currency only (never across
 * currencies, per #176's check-currency-consistency.ts lesson) -- the same
 * currency-total grain as P5.C.4/#203's getPortfolioReconciliation.
 *
 * Deliberately self-contained (own query, own terminal-status bucketing)
 * rather than importing #203's reconcilePortfolioTotals: #203 is an open,
 * unmerged PR, and this session has already seen three PRs (#163, #167,
 * #168) closed by Review and rebuilt, plus #203 itself avoided importing
 * #202 for the identical reason. A follow-up can collapse all three
 * (#202/#203/this) into one shared bucketing module once they merge.
 *
 * Terminal-status rules (claim.status: 'open' | 'recovered' | 'denied' |
 * 'written_off', migrations/0008, no DB CHECK constraint):
 *   - 'recovered'   -> cumulativeRecovered == amountClaimed, so
 *                      outstanding/writtenOff/denied are 0.
 *   - 'denied'      -> the unrecovered remainder is denied.
 *   - 'written_off' -> the unrecovered remainder is writtenOff (a
 *                      write-off can follow a nonzero partial recovery).
 *   - anything else -> the unrecovered remainder is outstanding.
 */
export interface ClientRecoverySummaryBucket {
  currency: string | null;
  claimed: string;
  recovered: string;
  outstanding: string;
  writtenOff: string;
  denied: string;
  /** claimed == recovered + outstanding + writtenOff + denied for this currency (same-currency amounts only). */
  reconciles: boolean;
}

const TERMINAL_RECOVERED = 'recovered';
const TERMINAL_DENIED = 'denied';
const TERMINAL_WRITTEN_OFF = 'written_off';

export async function getClientRecoverySummary(
  client: pg.PoolClient,
  clientId: string,
): Promise<ClientRecoverySummaryBucket[]> {
  const { rows: claimRows } = await client.query<{
    claim_id: string; amount_claimed: string; currency: string | null; status: string;
  }>(
    `SELECT id AS claim_id, amount_claimed, currency, status FROM claim WHERE client_id = $1`,
    [clientId],
  );

  if (claimRows.length === 0) return [];

  const claimIds = claimRows.map((r) => r.claim_id);
  const { rows: eventRows } = await client.query<{ claim_id: string; amount_recovered: string; currency: string | null }>(
    `SELECT claim_id, amount_recovered, currency FROM recovery_event WHERE client_id = $1 AND claim_id = ANY($2::uuid[])`,
    [clientId, claimIds],
  );

  const eventsByClaim = new Map<string, typeof eventRows>();
  for (const event of eventRows) {
    const list = eventsByClaim.get(event.claim_id) ?? [];
    list.push(event);
    eventsByClaim.set(event.claim_id, list);
  }

  interface Accumulator {
    currency: string | null;
    claimed: Decimal; recovered: Decimal; outstanding: Decimal; writtenOff: Decimal; denied: Decimal;
  }
  const buckets = new Map<string, Accumulator>();

  function bucketFor(currency: string | null): Accumulator {
    const key = currency ?? ' ';
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { currency, claimed: new Decimal(0), recovered: new Decimal(0), outstanding: new Decimal(0), writtenOff: new Decimal(0), denied: new Decimal(0) };
      buckets.set(key, bucket);
    }
    return bucket;
  }

  for (const claim of claimRows) {
    const bucket = bucketFor(claim.currency);
    const claimed = new Decimal(claim.amount_claimed);
    bucket.claimed = bucket.claimed.plus(claimed);

    let sameCurrencyRecovered = new Decimal(0);
    for (const event of eventsByClaim.get(claim.claim_id) ?? []) {
      if (event.currency !== null && event.currency === claim.currency) {
        sameCurrencyRecovered = sameCurrencyRecovered.plus(new Decimal(event.amount_recovered));
      }
      // NULL/mismatched-currency events are excluded from recovered, same
      // as #202/#203 -- no separate surfacing field here since this is a
      // client-facing summary, not an internal reconciliation report; the
      // underlying data-integrity concern is #203's job to surface.
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
      reconciles,
    };
  });
}
