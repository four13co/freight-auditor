import { describe, expect, it } from 'vitest';
import type { ParsedInvoice } from '../../src/modules/ingestion/charge-fact.js';
import { evaluateInvoice } from '../../src/modules/evaluator/evaluate-invoice.js';

function invoice(charges: ParsedInvoice['charges']): ParsedInvoice {
  return {
    transactionSet: 'PDF', parserVersion: 'test', headerCurrency: 'USD', charges,
    footing: { declaredTotal: '10.0000', lineSum: '10.0000' }, quarantinedCodes: [],
  };
}

describe('suspicious missing-data coverage markers', () => {
  it('marks a fuel charge that passes structural gates but has no rate/basis evidence', () => {
    const result = evaluateInvoice(invoice([
      { code: 'FSC', category: 'FUEL', amount: '10.0000', currency: 'USD', quarantined: false },
    ]));
    expect(result.coverageMarkers).toEqual([
      { chargeIndex: 0, code: 'FUEL_WITHOUT_RATE_BASIS', missingFields: ['rate', 'basis'] },
    ]);
    expect(result.findings.find((item) => item.criterionKey === 'STD.SUSPICIOUS_MISSING_DATA')?.result).toBe('VARIANCE');
  });

  it('marks only the missing half of an incomplete rate/basis pair', () => {
    const result = evaluateInvoice(invoice([
      { code: 'LH', category: 'LINEHAUL', amount: '10.0000', rate: '2.0000', currency: 'USD', quarantined: false },
    ]));
    expect(result.coverageMarkers).toContainEqual({
      chargeIndex: 0, code: 'INCOMPLETE_RATE_BASIS', missingFields: ['basis'],
    });
  });

  it('conforms when verification inputs are complete', () => {
    const result = evaluateInvoice(invoice([
      { code: 'FSC', category: 'FUEL', amount: '10.0000', rate: '2.0000', basis: '5.0000', currency: 'USD', quarantined: false },
    ]));
    expect(result.coverageMarkers).toEqual([]);
    expect(result.findings.find((item) => item.criterionKey === 'STD.SUSPICIOUS_MISSING_DATA')?.result).toBe('CONFORMED');
  });

  it('returns deterministic markers even when a hard gate rejects the invoice', () => {
    const result = evaluateInvoice(invoice([
      { category: 'LINEHAUL', amount: undefined, currency: 'USD', quarantined: true },
    ]));
    expect(result.outcome).toBe('REJECTED_REWORK');
    expect(result.coverageMarkers).toEqual([
      { chargeIndex: 0, code: 'MISSING_CHARGE_IDENTITY', missingFields: ['code', 'rawDescription'] },
    ]);
  });
});
