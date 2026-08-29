import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import { aggregateCarrierRecovery, type CarrierClaimRow, type CarrierRecoveryEventRow } from '../../src/modules/claims/aggregate-carrier-recovery.js';

const CARRIER_A = 'carrier-a';
const CARRIER_B = 'carrier-b';

function claim(overrides: Partial<CarrierClaimRow> & { claimId: string }): CarrierClaimRow {
  return { carrierId: CARRIER_A, amountClaimed: '1000.0000', currency: 'USD', status: 'open', ...overrides };
}

function event(overrides: Partial<CarrierRecoveryEventRow> & { claimId: string }): CarrierRecoveryEventRow {
  return { amountRecovered: '0.0000', currency: 'USD', ...overrides };
}

function assertReconciles(buckets: ReturnType<typeof aggregateCarrierRecovery>) {
  for (const b of buckets) {
    const sum = new Decimal(b.recovered).plus(b.outstanding).plus(b.writtenOff).plus(b.denied);
    expect(sum.toFixed(4)).toBe(new Decimal(b.claimed).toFixed(4));
  }
}

describe('aggregateCarrierRecovery', () => {
  it('returns an empty array for no claims', () => {
    expect(aggregateCarrierRecovery([], [])).toEqual([]);
  });

  it('an open claim with no recovery is entirely outstanding', () => {
    const buckets = aggregateCarrierRecovery(
      [claim({ claimId: 'c1', amountClaimed: '500.0000' })],
      [],
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ carrierId: CARRIER_A, currency: 'USD', claimed: '500.0000', recovered: '0.0000', outstanding: '500.0000', writtenOff: '0.0000', denied: '0.0000' });
    assertReconciles(buckets);
  });

  it('a fully recovered claim has zero outstanding/writtenOff/denied', () => {
    const buckets = aggregateCarrierRecovery(
      [claim({ claimId: 'c1', amountClaimed: '500.0000', status: 'recovered' })],
      [event({ claimId: 'c1', amountRecovered: '500.0000' })],
    );
    expect(buckets[0]).toMatchObject({ claimed: '500.0000', recovered: '500.0000', outstanding: '0.0000', writtenOff: '0.0000', denied: '0.0000' });
    assertReconciles(buckets);
  });

  it('a denied claim books the full claimed amount as denied, not writtenOff', () => {
    const buckets = aggregateCarrierRecovery(
      [claim({ claimId: 'c1', amountClaimed: '500.0000', status: 'denied' })],
      [],
    );
    expect(buckets[0]).toMatchObject({ claimed: '500.0000', recovered: '0.0000', outstanding: '0.0000', writtenOff: '0.0000', denied: '500.0000' });
    assertReconciles(buckets);
  });

  it('a written-off claim with a prior partial recovery books only the remainder as writtenOff', () => {
    const buckets = aggregateCarrierRecovery(
      [claim({ claimId: 'c1', amountClaimed: '500.0000', status: 'written_off' })],
      [event({ claimId: 'c1', amountRecovered: '200.0000' })],
    );
    expect(buckets[0]).toMatchObject({ claimed: '500.0000', recovered: '200.0000', outstanding: '0.0000', writtenOff: '300.0000', denied: '0.0000' });
    assertReconciles(buckets);
  });

  it('groups by carrier separately', () => {
    const buckets = aggregateCarrierRecovery(
      [
        claim({ claimId: 'c1', carrierId: CARRIER_A, amountClaimed: '100.0000' }),
        claim({ claimId: 'c2', carrierId: CARRIER_B, amountClaimed: '200.0000' }),
      ],
      [],
    );
    expect(buckets).toHaveLength(2);
    const a = buckets.find((b) => b.carrierId === CARRIER_A)!;
    const b = buckets.find((b) => b.carrierId === CARRIER_B)!;
    expect(a.claimed).toBe('100.0000');
    expect(b.claimed).toBe('200.0000');
    assertReconciles(buckets);
  });

  it('groups by currency separately within the same carrier, never summing across currencies', () => {
    const buckets = aggregateCarrierRecovery(
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
    const buckets = aggregateCarrierRecovery(
      [claim({ claimId: 'c1', amountClaimed: '500.0000' })],
      [event({ claimId: 'c1', amountRecovered: '100.0000', currency: null })],
    );
    expect(buckets[0]).toMatchObject({ claimed: '500.0000', recovered: '0.0000', outstanding: '500.0000', nullCurrencyRecovered: '100.0000' });
    assertReconciles(buckets);
  });

  it('surfaces a recovery_event whose currency mismatches the claim currency, excluded from recovered', () => {
    const buckets = aggregateCarrierRecovery(
      [claim({ claimId: 'c1', amountClaimed: '500.0000', currency: 'USD' })],
      [event({ claimId: 'c1', amountRecovered: '100.0000', currency: 'CAD' })],
    );
    expect(buckets[0]).toMatchObject({ claimed: '500.0000', recovered: '0.0000', outstanding: '500.0000', mismatchedCurrencyRecovered: '100.0000' });
    assertReconciles(buckets);
  });

  it('aggregates multiple claims of mixed outcomes into the correct combined bucket', () => {
    const buckets = aggregateCarrierRecovery(
      [
        claim({ claimId: 'c1', amountClaimed: '100.0000', status: 'open' }),
        claim({ claimId: 'c2', amountClaimed: '200.0000', status: 'recovered' }),
        claim({ claimId: 'c3', amountClaimed: '300.0000', status: 'denied' }),
        claim({ claimId: 'c4', amountClaimed: '400.0000', status: 'written_off' }),
      ],
      [
        event({ claimId: 'c2', amountRecovered: '200.0000' }),
        event({ claimId: 'c4', amountRecovered: '100.0000' }),
      ],
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({
      claimed: '1000.0000', recovered: '300.0000', outstanding: '100.0000', writtenOff: '300.0000', denied: '300.0000',
    });
    assertReconciles(buckets);
  });
});
