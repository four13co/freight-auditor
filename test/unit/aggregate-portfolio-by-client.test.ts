import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import { aggregatePortfolioByClient, type PortfolioClaimRow, type PortfolioRecoveryEventRow } from '../../src/modules/claims/aggregate-portfolio-by-client.js';

const CLIENT_A = 'client-a';
const CLIENT_B = 'client-b';

function claim(overrides: Partial<PortfolioClaimRow> & { claimId: string }): PortfolioClaimRow {
  return { clientId: CLIENT_A, clientName: 'Client A', amountClaimed: '1000.0000', currency: 'USD', status: 'open', ...overrides };
}

function event(overrides: Partial<PortfolioRecoveryEventRow> & { claimId: string }): PortfolioRecoveryEventRow {
  return { amountRecovered: '0.0000', currency: 'USD', ...overrides };
}

function assertReconciles(buckets: ReturnType<typeof aggregatePortfolioByClient>) {
  for (const b of buckets) {
    const sum = new Decimal(b.recovered).plus(b.outstanding).plus(b.writtenOff).plus(b.denied);
    expect(sum.toFixed(4)).toBe(new Decimal(b.claimed).toFixed(4));
    expect(b.reconciles).toBe(true);
  }
}

describe('aggregatePortfolioByClient', () => {
  it('returns an empty array for no claims', () => {
    expect(aggregatePortfolioByClient([], [])).toEqual([]);
  });

  it('an open claim with no recovery is entirely outstanding', () => {
    const buckets = aggregatePortfolioByClient(
      [claim({ claimId: 'c1', amountClaimed: '500.0000' })],
      [],
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ clientId: CLIENT_A, clientName: 'Client A', currency: 'USD', claimed: '500.0000', recovered: '0.0000', outstanding: '500.0000', writtenOff: '0.0000', denied: '0.0000' });
    assertReconciles(buckets);
  });

  it('a fully recovered claim has zero outstanding/writtenOff/denied', () => {
    const buckets = aggregatePortfolioByClient(
      [claim({ claimId: 'c1', amountClaimed: '500.0000', status: 'recovered' })],
      [event({ claimId: 'c1', amountRecovered: '500.0000' })],
    );
    expect(buckets[0]).toMatchObject({ claimed: '500.0000', recovered: '500.0000', outstanding: '0.0000', writtenOff: '0.0000', denied: '0.0000' });
    assertReconciles(buckets);
  });

  it('a denied claim books the full claimed amount as denied, not writtenOff', () => {
    const buckets = aggregatePortfolioByClient(
      [claim({ claimId: 'c1', amountClaimed: '500.0000', status: 'denied' })],
      [],
    );
    expect(buckets[0]).toMatchObject({ claimed: '500.0000', recovered: '0.0000', outstanding: '0.0000', writtenOff: '0.0000', denied: '500.0000' });
    assertReconciles(buckets);
  });

  it('a written-off claim with a prior partial recovery books only the remainder as writtenOff', () => {
    const buckets = aggregatePortfolioByClient(
      [claim({ claimId: 'c1', amountClaimed: '500.0000', status: 'written_off' })],
      [event({ claimId: 'c1', amountRecovered: '200.0000' })],
    );
    expect(buckets[0]).toMatchObject({ claimed: '500.0000', recovered: '200.0000', outstanding: '0.0000', writtenOff: '300.0000', denied: '0.0000' });
    assertReconciles(buckets);
  });

  it('groups by client separately (the whole point: cross-client, not cross-carrier)', () => {
    const buckets = aggregatePortfolioByClient(
      [
        claim({ claimId: 'c1', clientId: CLIENT_A, clientName: 'Client A', amountClaimed: '100.0000' }),
        claim({ claimId: 'c2', clientId: CLIENT_B, clientName: 'Client B', amountClaimed: '200.0000' }),
      ],
      [],
    );
    expect(buckets).toHaveLength(2);
    const a = buckets.find((b) => b.clientId === CLIENT_A)!;
    const b = buckets.find((b) => b.clientId === CLIENT_B)!;
    expect(a).toMatchObject({ clientName: 'Client A', claimed: '100.0000' });
    expect(b).toMatchObject({ clientName: 'Client B', claimed: '200.0000' });
    assertReconciles(buckets);
  });

  it('groups by currency separately within the same client, never summing across currencies', () => {
    const buckets = aggregatePortfolioByClient(
      [
        claim({ claimId: 'c1', currency: 'USD', amountClaimed: '100.0000' }),
        claim({ claimId: 'c2', currency: 'CAD', amountClaimed: '150.0000' }),
      ],
      [],
    );
    expect(buckets).toHaveLength(2);
    expect(buckets.find((b) => b.currency === 'USD')!.claimed).toBe('100.0000');
    expect(buckets.find((b) => b.currency === 'CAD')!.claimed).toBe('150.0000');
  });

  it('surfaces a NULL-currency recovery_event separately, excluded from recovered', () => {
    const buckets = aggregatePortfolioByClient(
      [claim({ claimId: 'c1', amountClaimed: '500.0000' })],
      [event({ claimId: 'c1', amountRecovered: '100.0000', currency: null })],
    );
    expect(buckets[0]).toMatchObject({ claimed: '500.0000', recovered: '0.0000', outstanding: '500.0000', nullCurrencyRecovered: '100.0000' });
    assertReconciles(buckets);
  });

  it('surfaces a recovery_event whose currency mismatches the claim currency, excluded from recovered', () => {
    const buckets = aggregatePortfolioByClient(
      [claim({ claimId: 'c1', amountClaimed: '500.0000', currency: 'USD' })],
      [event({ claimId: 'c1', amountRecovered: '100.0000', currency: 'CAD' })],
    );
    expect(buckets[0]).toMatchObject({ claimed: '500.0000', recovered: '0.0000', outstanding: '500.0000', mismatchedCurrencyRecovered: '100.0000' });
    assertReconciles(buckets);
  });

  it('aggregates multiple claims of mixed outcomes across multiple clients into the correct per-client buckets', () => {
    const buckets = aggregatePortfolioByClient(
      [
        claim({ claimId: 'c1', clientId: CLIENT_A, clientName: 'Client A', amountClaimed: '100.0000', status: 'open' }),
        claim({ claimId: 'c2', clientId: CLIENT_A, clientName: 'Client A', amountClaimed: '200.0000', status: 'recovered' }),
        claim({ claimId: 'c3', clientId: CLIENT_B, clientName: 'Client B', amountClaimed: '300.0000', status: 'denied' }),
        claim({ claimId: 'c4', clientId: CLIENT_B, clientName: 'Client B', amountClaimed: '400.0000', status: 'written_off' }),
      ],
      [
        event({ claimId: 'c2', amountRecovered: '200.0000' }),
        event({ claimId: 'c4', amountRecovered: '100.0000' }),
      ],
    );
    expect(buckets).toHaveLength(2);
    const a = buckets.find((b) => b.clientId === CLIENT_A)!;
    const b = buckets.find((b) => b.clientId === CLIENT_B)!;
    expect(a).toMatchObject({ claimed: '300.0000', recovered: '200.0000', outstanding: '100.0000', writtenOff: '0.0000', denied: '0.0000' });
    expect(b).toMatchObject({ claimed: '700.0000', recovered: '100.0000', outstanding: '0.0000', writtenOff: '300.0000', denied: '300.0000' });
    assertReconciles(buckets);
  });
});
