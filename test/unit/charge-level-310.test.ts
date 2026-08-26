import { describe, expect, it } from 'vitest';
import { GOLDEN_210, GOLDEN_310, MIXED_CURRENCY_LINEHAUL_310 } from '../fixtures/edi-golden.js';
import { parse210 } from '../../src/modules/ingestion/parse-210.js';
import { parse310 } from '../../src/modules/ingestion/parse-310.js';
import { evaluateInvoice } from '../../src/modules/evaluator/evaluate-invoice.js';

const categorize = (code: string | undefined) => code;

describe('EDI 310 charge-level and currency-consistency checks', () => {
  it('accepts identified charges with normalized currency codes', () => {
    const result = evaluateInvoice(parse310(GOLDEN_310, categorize));
    expect(result.gateFailures.some((gate) => gate.criterionKey.startsWith('STD.310.CHARGE_'))).toBe(false);
  });

  it('rejects an anonymous charge line', () => {
    const raw = GOLDEN_310.replace('****500****Ocean Freight', '************');
    const result = evaluateInvoice(parse310(raw, categorize));
    expect(result.gateFailures.map((gate) => gate.criterionKey)).toContain('STD.310.CHARGE_IDENTITY_REQUIRED');
  });

  it('rejects a non-normalized currency code instead of treating it as money metadata', () => {
    const raw = GOLDEN_310.replace('********USD~', '********US~');
    const result = evaluateInvoice(parse310(raw, categorize));
    expect(result.gateFailures.map((gate) => gate.criterionKey)).toContain('STD.310.CURRENCY_CODE_VALID');
  });

  it('flags mixed charge currencies without combining their meaning', () => {
    const result = evaluateInvoice(parse310(MIXED_CURRENCY_LINEHAUL_310, categorize));
    expect(result.findings.find(
      (finding) => finding.criterionKey === 'STD.310.CURRENCY_CONSISTENCY',
    )?.result).toBe('VARIANCE');
  });

  it('does not apply ocean-only checks to motor invoices', () => {
    const result = evaluateInvoice(parse210(GOLDEN_210, categorize));
    expect(result.gateFailures.some((gate) => gate.criterionKey.startsWith('STD.310.'))).toBe(false);
    expect(result.findings.find(
      (finding) => finding.criterionKey === 'STD.310.CURRENCY_CONSISTENCY',
    )?.result).toBe('UNASSESSABLE');
  });
});
