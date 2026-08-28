import { describe, it, expect } from 'vitest';
import {
  composeShortPayDecision,
  ShortPayDecisionError,
  type ChargeFactRow,
  type AcceptedOverchargeFindingRow,
} from '../../src/modules/payments/compose-short-pay-decision.js';

const charges: ChargeFactRow[] = [
  { amount: '600.0000', currency: 'USD' },
  { amount: '400.0000', currency: 'USD' },
];

const finding = (over: Partial<AcceptedOverchargeFindingRow> = {}): AcceptedOverchargeFindingRow => ({
  id: 'f1111111-1111-1111-1111-111111111111',
  currency: 'USD',
  varianceAmount: '150.0000',
  ...over,
});

describe('composeShortPayDecision', () => {
  it('pays the invoice total minus withheld accepted overcharge', () => {
    const result = composeShortPayDecision(charges, [finding()]);
    expect(result).toEqual({
      amountToPay: '850.0000',
      withheldAmount: '150.0000',
      currency: 'USD',
      findingIds: [finding().id],
    });
  });

  it('sums multiple accepted overcharge findings deterministically by id', () => {
    const a = finding({ id: 'a1111111-1111-1111-1111-111111111111', varianceAmount: '50.0000' });
    const b = finding({ id: 'b2222222-2222-2222-2222-222222222222', varianceAmount: '75.0000' });
    const result = composeShortPayDecision(charges, [b, a]);
    expect(result.withheldAmount).toBe('125.0000');
    expect(result.findingIds).toEqual([a.id, b.id]);
  });

  it('rejects an empty finding set', () => {
    expect(() => composeShortPayDecision(charges, [])).toThrow(ShortPayDecisionError);
    try {
      composeShortPayDecision(charges, []);
      expect.unreachable();
    } catch (err) {
      expect((err as ShortPayDecisionError).code).toBe('EMPTY_SET');
    }
  });

  it('rejects mixed currency between charges and findings', () => {
    try {
      composeShortPayDecision(charges, [finding({ currency: 'CAD' })]);
      expect.unreachable();
    } catch (err) {
      expect((err as ShortPayDecisionError).code).toBe('MIXED_CURRENCY');
    }
  });

  it('rejects mixed currency across charge_fact rows', () => {
    try {
      composeShortPayDecision([{ amount: '600.0000', currency: 'USD' }, { amount: '400.0000', currency: 'CAD' }], [finding()]);
      expect.unreachable();
    } catch (err) {
      expect((err as ShortPayDecisionError).code).toBe('MIXED_CURRENCY');
    }
  });

  it('rejects a finding with a null currency', () => {
    try {
      composeShortPayDecision(charges, [finding({ currency: null })]);
      expect.unreachable();
    } catch (err) {
      expect((err as ShortPayDecisionError).code).toBe('MISSING_AMOUNT');
    }
  });

  it('rejects a finding with a null variance amount', () => {
    try {
      composeShortPayDecision(charges, [finding({ varianceAmount: null })]);
      expect.unreachable();
    } catch (err) {
      expect((err as ShortPayDecisionError).code).toBe('MISSING_AMOUNT');
    }
  });

  it('rejects a charge_fact row with a null currency', () => {
    try {
      composeShortPayDecision([{ amount: '600.0000', currency: null }], [finding()]);
      expect.unreachable();
    } catch (err) {
      expect((err as ShortPayDecisionError).code).toBe('MISSING_AMOUNT');
    }
  });

  it('rejects a withheld amount that equals the invoice total', () => {
    try {
      composeShortPayDecision(charges, [finding({ varianceAmount: '1000.0000' })]);
      expect.unreachable();
    } catch (err) {
      expect((err as ShortPayDecisionError).code).toBe('WITHHELD_EXCEEDS_TOTAL');
    }
  });

  it('rejects a withheld amount that exceeds the invoice total', () => {
    try {
      composeShortPayDecision(charges, [finding({ varianceAmount: '1500.0000' })]);
      expect.unreachable();
    } catch (err) {
      expect((err as ShortPayDecisionError).code).toBe('WITHHELD_EXCEEDS_TOTAL');
    }
  });
});
