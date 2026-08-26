import { describe, expect, it } from 'vitest';
import { alignTier1Charges } from '../../src/modules/rate-engine/align-tier1-charges.js';

describe('alignTier1Charges', () => {
  it('deterministically aligns exact one-to-one category and currency pairs', () => {
    const result = alignTier1Charges(
      [{ chargeFactId: 'b-line', category: ' linehaul ', currency: 'usd' }, { chargeFactId: 'b-fuel', category: 'FUEL', currency: 'USD' }],
      [{ expectedChargeId: 'e-line', category: 'LINEHAUL', currency: 'USD' }, { expectedChargeId: 'e-fuel', category: 'fuel', currency: 'usd' }],
    );
    expect(result.unassessable).toEqual([]);
    expect(result.alignments.map((a) => [a.key, a.chargeFactId, a.expectedChargeId])).toEqual([
      ['FUEL|USD', 'b-fuel', 'e-fuel'], ['LINEHAUL|USD', 'b-line', 'e-line'],
    ]);
  });

  it('reports missing sides and classification without guessing', () => {
    const result = alignTier1Charges(
      [{ chargeFactId: 'b1', category: null, currency: 'USD' }, { chargeFactId: 'b2', category: 'FUEL', currency: 'USD' }],
      [{ expectedChargeId: 'e1', category: 'ACCESSORIAL', currency: 'USD' }],
    );
    expect(result.alignments).toEqual([]);
    expect(result.unassessable.map((i) => i.reason)).toEqual(['EXPECTED_ONLY', 'MISSING_CLASSIFICATION', 'BILLED_ONLY']);
  });

  it('routes duplicate-category candidates to ambiguous instead of pairing by order', () => {
    const result = alignTier1Charges(
      [{ chargeFactId: 'b2', category: 'FUEL', currency: 'USD' }, { chargeFactId: 'b1', category: 'FUEL', currency: 'USD' }],
      [{ expectedChargeId: 'e1', category: 'FUEL', currency: 'USD' }],
    );
    expect(result.alignments).toEqual([]);
    expect(result.unassessable).toEqual([{ key: 'FUEL|USD', reason: 'AMBIGUOUS', chargeFactIds: ['b1', 'b2'], expectedChargeIds: ['e1'] }]);
  });

  it('fails closed on missing or duplicate record identities', () => {
    expect(() => alignTier1Charges([{ chargeFactId: '', category: 'FUEL', currency: 'USD' }], [])).toThrow('id is required');
    expect(() => alignTier1Charges([
      { chargeFactId: 'same', category: 'FUEL', currency: 'USD' },
      { chargeFactId: 'same', category: 'LINEHAUL', currency: 'USD' },
    ], [])).toThrow('duplicate billed charge id: same');
  });
});
