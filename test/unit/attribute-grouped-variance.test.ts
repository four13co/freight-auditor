import { describe, expect, it } from 'vitest';
import { attributeGroupedVariance } from '../../src/modules/rate-engine/attribute-grouped-variance.js';

describe('attributeGroupedVariance', () => {
  it('attributes grouped totals with every contributor', () => {
    const result = attributeGroupedVariance([{ level: 'GROUP', key: 'fuel',
      billed: [{ id: 'b2', amount: '6.005', currency: 'usd' }, { id: 'b1', amount: '5', currency: 'USD' }],
      expected: [{ id: 'e1', amount: '10', currency: 'USD' }] }]);
    expect(result).toEqual({ unassessable: [], attributed: [{ level: 'GROUP', key: 'fuel', currency: 'USD',
      billedIds: ['b1', 'b2'], expectedIds: ['e1'], billedTotal: '11.0050', expectedTotal: '10.0000',
      varianceAmount: '1.0050', direction: 'OVERCHARGE' }] });
  });

  it('supports invoice-level undercharge attribution', () => {
    const [row] = attributeGroupedVariance([{ level: 'INVOICE', key: 'invoice-1',
      billed: [{ id: 'b', amount: '8', currency: 'USD' }], expected: [{ id: 'e', amount: '10', currency: 'USD' }] }]).attributed;
    expect(row?.direction).toBe('UNDERCHARGE');
    expect(row?.varianceAmount).toBe('-2.0000');
  });

  it('returns explicit unassessable outcomes for missing sides and currency mismatch', () => {
    const result = attributeGroupedVariance([
      { level: 'GROUP', key: 'a', billed: [], expected: [{ id: 'e', amount: '1', currency: 'USD' }] },
      { level: 'GROUP', key: 'b', billed: [{ id: 'b', amount: '1', currency: 'USD' }], expected: [{ id: 'e2', amount: '1', currency: 'CAD' }] },
    ]);
    expect(result.unassessable.map((i) => i.reason)).toEqual(['MISSING_SIDE', 'CURRENCY_MISMATCH']);
  });

  it('fails closed on duplicate attribution or member identity and invalid amount', () => {
    const base = { level: 'GROUP' as const, key: 'x', billed: [{ id: 'b', amount: '1', currency: 'USD' }], expected: [{ id: 'e', amount: '1', currency: 'USD' }] };
    expect(() => attributeGroupedVariance([base, base])).toThrow('duplicate attribution key');
    expect(() => attributeGroupedVariance([base, { ...base, key: 'y' }])).toThrow('member appears in multiple');
    expect(() => attributeGroupedVariance([{ ...base, billed: [{ id: 'b', amount: 'nope', currency: 'USD' }] }])).toThrow('invalid member amount');
  });
});
