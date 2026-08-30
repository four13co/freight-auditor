import { describe, it, expect } from 'vitest';
import { checkCurrencyConsistency } from '../../src/modules/claims/check-currency-consistency.js';

describe('checkCurrencyConsistency', () => {
  it('reports consistent for an empty event set', () => {
    const result = checkCurrencyConsistency('c1', 'USD', []);
    expect(result.consistent).toBe(true);
    expect(result.currencies).toEqual([]);
  });

  it('reports consistent when every event matches the claim currency', () => {
    const result = checkCurrencyConsistency('c1', 'USD', [
      { id: 'e1', currency: 'USD' },
      { id: 'e2', currency: 'USD' },
    ]);
    expect(result.consistent).toBe(true);
    expect(result.currencies).toEqual(['USD']);
  });

  it('reports inconsistent when events span more than one currency', () => {
    const result = checkCurrencyConsistency('c1', 'USD', [
      { id: 'e1', currency: 'USD' },
      { id: 'e2', currency: 'CAD' },
    ]);
    expect(result.consistent).toBe(false);
    expect(result.currencies).toEqual(['CAD', 'USD']);
  });

  it('reports inconsistent and names mismatched events when an event disagrees with the claim currency', () => {
    const result = checkCurrencyConsistency('c1', 'USD', [
      { id: 'e1', currency: 'USD' },
      { id: 'e2', currency: 'EUR' },
    ]);
    expect(result.consistent).toBe(false);
    expect(result.mismatchedEventIds).toEqual(['e2']);
  });

  it('surfaces a null-currency event as its own finding and marks the claim inconsistent', () => {
    const result = checkCurrencyConsistency('c1', 'USD', [
      { id: 'e1', currency: 'USD' },
      { id: 'e2', currency: null },
    ]);
    expect(result.consistent).toBe(false);
    expect(result.nullCurrencyEventIds).toEqual(['e2']);
  });

  it('never checks mismatch against a null claim currency, but still flags multi-currency events', () => {
    const result = checkCurrencyConsistency('c1', null, [
      { id: 'e1', currency: 'USD' },
      { id: 'e2', currency: 'CAD' },
    ]);
    expect(result.mismatchedEventIds).toEqual([]);
    expect(result.consistent).toBe(false);
    expect(result.currencies).toEqual(['CAD', 'USD']);
  });

  it('is consistent with a null claim currency and exactly one event currency', () => {
    const result = checkCurrencyConsistency('c1', null, [{ id: 'e1', currency: 'USD' }]);
    expect(result.consistent).toBe(true);
  });
});
