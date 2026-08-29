import { describe, it, expect } from 'vitest';
import { computeClaimAgingDeadline } from '../../src/modules/claims/compute-claim-aging-deadline.js';

describe('computeClaimAgingDeadline', () => {
  it('adds 30 days by default', () => {
    const result = computeClaimAgingDeadline({ openedAt: '2026-01-01T00:00:00Z' });
    expect(result.toISOString()).toBe('2026-01-31T00:00:00.000Z');
  });

  it('adds the given number of aging days', () => {
    const result = computeClaimAgingDeadline({ openedAt: '2026-01-01T00:00:00Z', agingDays: 7 });
    expect(result.toISOString()).toBe('2026-01-08T00:00:00.000Z');
  });

  it('accepts a Date instance for openedAt', () => {
    const result = computeClaimAgingDeadline({ openedAt: new Date('2026-01-01T00:00:00Z'), agingDays: 1 });
    expect(result.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });

  it('correctly crosses a month boundary', () => {
    const result = computeClaimAgingDeadline({ openedAt: '2026-01-25T00:00:00Z', agingDays: 10 });
    expect(result.toISOString()).toBe('2026-02-04T00:00:00.000Z');
  });

  it('rejects a non-positive aging-days value', () => {
    expect(() => computeClaimAgingDeadline({ openedAt: '2026-01-01T00:00:00Z', agingDays: 0 })).toThrow();
    expect(() => computeClaimAgingDeadline({ openedAt: '2026-01-01T00:00:00Z', agingDays: -1 })).toThrow();
  });

  it('rejects an invalid openedAt string', () => {
    expect(() => computeClaimAgingDeadline({ openedAt: 'not-a-date' })).toThrow();
  });
});
