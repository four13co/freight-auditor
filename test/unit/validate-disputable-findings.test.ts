import { describe, expect, it } from 'vitest';
import {
  validateDisputableFindings,
  DisputableFindingsError,
  type DisputableFindingRow,
} from '../../src/modules/disputes/validate-disputable-findings.js';

const carrierA = '11111111-1111-4111-8111-111111111111';
const carrierB = '22222222-2222-4222-8222-222222222222';

function row(overrides: Partial<DisputableFindingRow> = {}): DisputableFindingRow {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    status: 'accepted',
    carrierId: carrierA,
    currency: 'USD',
    varianceAmount: '100.0000',
    direction: 'OVERCHARGE',
    ...overrides,
  };
}

describe('validateDisputableFindings', () => {
  it('sums overcharge findings for one carrier and currency', () => {
    const result = validateDisputableFindings([
      row({ id: 'f1', varianceAmount: '100.0000' }),
      row({ id: 'f2', varianceAmount: '50.5000' }),
    ]);
    expect(result).toEqual({
      findingIds: ['f1', 'f2'],
      carrierId: carrierA,
      currency: 'USD',
      amountClaimed: '150.5000',
    });
  });

  it('excludes UNDERCHARGE findings from the claim without rejecting the whole set', () => {
    const result = validateDisputableFindings([
      row({ id: 'f1', varianceAmount: '100.0000', direction: 'OVERCHARGE' }),
      row({ id: 'f2', varianceAmount: '9999.0000', direction: 'UNDERCHARGE' }),
    ]);
    expect(result.findingIds).toEqual(['f1']);
    expect(result.amountClaimed).toBe('100.0000');
  });

  it('rejects an empty set', () => {
    expect(() => validateDisputableFindings([])).toThrow(DisputableFindingsError);
    expect(() => validateDisputableFindings([])).toThrow(expect.objectContaining({ code: 'EMPTY_SET' }));
  });

  it('rejects a set that is entirely UNDERCHARGE as equivalent to empty', () => {
    expect(() => validateDisputableFindings([row({ direction: 'UNDERCHARGE' })]))
      .toThrow(expect.objectContaining({ code: 'EMPTY_SET' }));
  });

  it('rejects a finding not in accepted status', () => {
    expect(() => validateDisputableFindings([row({ status: 'open' })]))
      .toThrow(expect.objectContaining({ code: 'NOT_ACCEPTED' }));
  });

  it('rejects findings spanning more than one carrier', () => {
    expect(() => validateDisputableFindings([
      row({ id: 'f1', carrierId: carrierA }),
      row({ id: 'f2', carrierId: carrierB }),
    ])).toThrow(expect.objectContaining({ code: 'MIXED_CARRIER' }));
  });

  it('rejects findings spanning more than one currency', () => {
    expect(() => validateDisputableFindings([
      row({ id: 'f1', currency: 'USD' }),
      row({ id: 'f2', currency: 'EUR' }),
    ])).toThrow(expect.objectContaining({ code: 'MIXED_CURRENCY' }));
  });

  it('rejects a finding with no carrier attributable', () => {
    expect(() => validateDisputableFindings([row({ carrierId: null })]))
      .toThrow(expect.objectContaining({ code: 'MISSING_CARRIER' }));
  });

  it('rejects a finding with a null variance amount or currency', () => {
    expect(() => validateDisputableFindings([row({ varianceAmount: null })]))
      .toThrow(expect.objectContaining({ code: 'MISSING_AMOUNT' }));
    expect(() => validateDisputableFindings([row({ currency: null })]))
      .toThrow(expect.objectContaining({ code: 'MISSING_AMOUNT' }));
  });

  it('sums with decimal precision, never floating-point drift', () => {
    const result = validateDisputableFindings([
      row({ id: 'f1', varianceAmount: '0.1000' }),
      row({ id: 'f2', varianceAmount: '0.2000' }),
    ]);
    expect(result.amountClaimed).toBe('0.3000');
  });
});
