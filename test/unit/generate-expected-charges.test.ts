import { describe, expect, it, vi } from 'vitest';
import { generateExpectedCharges, persistExpectedCharges } from '../../src/modules/rate-engine/generate-expected-charges.js';

describe('generateExpectedCharges', () => {
  it('computes canonical decimal amounts and stable ordering', () => {
    const result = generateExpectedCharges([
      { sourceKey: 'fuel-1', category: 'fuel', currency: 'usd', calculation: { kind: 'RATE_TIMES_BASIS', rate: '0.33333', basis: '3' } },
      { sourceKey: 'linehaul-1', category: 'linehaul', currency: 'USD', calculation: { kind: 'FLAT', amount: '100' } },
    ]);
    expect(result.map((row) => [row.category, row.expectedAmount])).toEqual([['FUEL', '1.0000'], ['LINEHAUL', '100.0000']]);
    expect(generateExpectedCharges([{ sourceKey: 'fuel-1', category: 'fuel', currency: 'usd', calculation: { kind: 'RATE_TIMES_BASIS', rate: '0.33333', basis: '3' } }])[0]!.idempotencyKey)
      .toBe(result[0]!.idempotencyKey);
  });

  it.each([
    [[{ sourceKey: '', category: 'FUEL', currency: 'USD', calculation: { kind: 'FLAT', amount: '1' } }], 'sourceKey is required'],
    [[{ sourceKey: 'x', category: 'FUEL', currency: 'US', calculation: { kind: 'FLAT', amount: '1' } }], 'invalid currency'],
    [[{ sourceKey: 'x', category: 'FUEL', currency: 'USD', calculation: { kind: 'FLAT', amount: '-1' } }], 'non-negative'],
  ] as const)('fails closed for invalid input', (specs, message) => {
    expect(() => generateExpectedCharges(specs)).toThrow(message);
  });

  it('rejects duplicate source identities', () => {
    const spec = { sourceKey: 'same', category: 'FUEL', currency: 'USD', calculation: { kind: 'FLAT' as const, amount: '1' } };
    expect(() => generateExpectedCharges([spec, spec])).toThrow('duplicate expected-charge sourceKey');
  });

  it('persists new rows and resolves an exact retry to its original id', async () => {
    const charge = generateExpectedCharges([{ sourceKey: 'x', category: 'FUEL', currency: 'USD', calculation: { kind: 'FLAT', amount: '1' } }])[0]!;
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'new-id' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        id: 'new-id', category: charge.category, currency: charge.currency,
        expected_amount: charge.expectedAmount, source_key: charge.sourceKey,
        calculation: charge.calculation, charge_fact_id: null, clause_id: null, rate_cell_id: null, source_document_id: null,
      }] });
    const client = { query } as never;
    await expect(persistExpectedCharges(client, { clientId: 'c', auditRunId: 'r', charges: [charge] })).resolves.toEqual(['new-id']);
    await expect(persistExpectedCharges(client, { clientId: 'c', auditRunId: 'r', charges: [charge] })).resolves.toEqual(['new-id']);
  });

  it('fails closed when the same source was previously computed differently', async () => {
    const charge = generateExpectedCharges([{ sourceKey: 'x', category: 'FUEL', currency: 'USD', calculation: { kind: 'FLAT', amount: '1' } }])[0]!;
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{
      id: 'old-id', category: 'FUEL', currency: 'USD', expected_amount: '2.0000', source_key: 'x',
      calculation: { kind: 'FLAT', amount: '2.0000' }, charge_fact_id: null, clause_id: null, rate_cell_id: null, source_document_id: null,
    }] });
    await expect(persistExpectedCharges({ query } as never, { clientId: 'c', auditRunId: 'r', charges: [charge] }))
      .rejects.toThrow('expected-charge source conflict: x');
  });
});
