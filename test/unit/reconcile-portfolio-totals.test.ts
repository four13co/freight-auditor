import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import { reconcilePortfolioTotals, type ReconcilableClaimRow, type ReconcilableRecoveryEventRow } from '../../src/modules/claims/reconcile-portfolio-totals.js';

function claim(overrides: Partial<ReconcilableClaimRow> & { claimId: string }): ReconcilableClaimRow {
  return { amountClaimed: '1000.0000', currency: 'USD', status: 'open', ...overrides };
}

function event(overrides: Partial<ReconcilableRecoveryEventRow> & { claimId: string }): ReconcilableRecoveryEventRow {
  return { amountRecovered: '0.0000', currency: 'USD', ...overrides };
}

function assertReconciles(buckets: ReturnType<typeof reconcilePortfolioTotals>) {
  for (const b of buckets) {
    const sum = new Decimal(b.recovered).plus(b.outstanding).plus(b.writtenOff).plus(b.denied);
    expect(sum.toFixed(4)).toBe(new Decimal(b.claimed).toFixed(4));
    expect(b.reconciles).toBe(true);
  }
}

describe('reconcilePortfolioTotals', () => {
  it('returns an empty array for no claims', () => {
    expect(reconcilePortfolioTotals([], [])).toEqual([]);
  });

  it('rolls up two claims from different implicit carriers into one currency bucket', () => {
    const buckets = reconcilePortfolioTotals(
      [
        claim({ claimId: 'c1', amountClaimed: '500.0000', status: 'recovered' }),
        claim({ claimId: 'c2', amountClaimed: '300.0000' }),
      ],
      [event({ claimId: 'c1', amountRecovered: '500.0000' })],
    );

    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({
      currency: 'USD', claimed: '800.0000', recovered: '500.0000', outstanding: '300.0000',
      writtenOff: '0.0000', denied: '0.0000', reconciles: true,
    });
    assertReconciles(buckets);
  });

  it('keeps different currencies in separate buckets, never summed together', () => {
    const buckets = reconcilePortfolioTotals(
      [
        claim({ claimId: 'c1', currency: 'USD', amountClaimed: '500.0000', status: 'recovered' }),
        claim({ claimId: 'c2', currency: 'CAD', amountClaimed: '200.0000' }),
      ],
      [event({ claimId: 'c1', currency: 'USD', amountRecovered: '500.0000' })],
    );

    expect(buckets).toHaveLength(2);
    expect(buckets.find((b) => b.currency === 'USD')).toMatchObject({ claimed: '500.0000', reconciles: true });
    expect(buckets.find((b) => b.currency === 'CAD')).toMatchObject({ claimed: '200.0000', reconciles: true });
    assertReconciles(buckets);
  });

  it('a denied claim books the full claimed amount as denied, not writtenOff', () => {
    const buckets = reconcilePortfolioTotals(
      [claim({ claimId: 'c1', amountClaimed: '500.0000', status: 'denied' })],
      [],
    );
    expect(buckets[0]).toMatchObject({ claimed: '500.0000', recovered: '0.0000', outstanding: '0.0000', writtenOff: '0.0000', denied: '500.0000' });
    assertReconciles(buckets);
  });

  it('a written-off claim with a prior partial recovery books only the remainder as writtenOff', () => {
    const buckets = reconcilePortfolioTotals(
      [claim({ claimId: 'c1', amountClaimed: '500.0000', status: 'written_off' })],
      [event({ claimId: 'c1', amountRecovered: '200.0000' })],
    );
    expect(buckets[0]).toMatchObject({ claimed: '500.0000', recovered: '200.0000', outstanding: '0.0000', writtenOff: '300.0000', denied: '0.0000' });
    assertReconciles(buckets);
  });

  it('surfaces a NULL-currency recovery_event separately, excluded from recovered', () => {
    const buckets = reconcilePortfolioTotals(
      [claim({ claimId: 'c1', amountClaimed: '500.0000' })],
      [event({ claimId: 'c1', amountRecovered: '100.0000', currency: null })],
    );
    expect(buckets[0]).toMatchObject({ recovered: '0.0000', nullCurrencyRecovered: '100.0000', outstanding: '500.0000' });
    assertReconciles(buckets);
  });

  it('surfaces a mismatched-currency recovery_event separately, excluded from recovered', () => {
    const buckets = reconcilePortfolioTotals(
      [claim({ claimId: 'c1', amountClaimed: '500.0000', currency: 'USD' })],
      [event({ claimId: 'c1', amountRecovered: '100.0000', currency: 'CAD' })],
    );
    expect(buckets[0]).toMatchObject({ recovered: '0.0000', mismatchedCurrencyRecovered: '100.0000', outstanding: '500.0000' });
    assertReconciles(buckets);
  });

  it('a mixed-outcome portfolio (open, recovered, denied, written-off) still reconciles', () => {
    const buckets = reconcilePortfolioTotals(
      [
        claim({ claimId: 'c1', amountClaimed: '100.0000', status: 'open' }),
        claim({ claimId: 'c2', amountClaimed: '200.0000', status: 'recovered' }),
        claim({ claimId: 'c3', amountClaimed: '150.0000', status: 'denied' }),
        claim({ claimId: 'c4', amountClaimed: '300.0000', status: 'written_off' }),
      ],
      [
        event({ claimId: 'c2', amountRecovered: '200.0000' }),
        event({ claimId: 'c4', amountRecovered: '100.0000' }),
      ],
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({
      claimed: '750.0000', recovered: '300.0000', outstanding: '100.0000', writtenOff: '200.0000', denied: '150.0000',
    });
    assertReconciles(buckets);
  });
});
