import { describe, expect, it } from 'vitest';
import { GOLDEN_210, GOLDEN_310 } from '../fixtures/edi-golden.js';
import { parse210 } from '../../src/modules/ingestion/parse-210.js';
import { parse310 } from '../../src/modules/ingestion/parse-310.js';
import { evaluateInvoice } from '../../src/modules/evaluator/evaluate-invoice.js';

const categorize = (code: string | undefined) => code;
const keys = [
  'STD.310.INVOICE_NUMBER_REQUIRED', 'STD.310.REFERENCE_REQUIRED', 'STD.310.CONTAINER_REQUIRED',
  'STD.310.VESSEL_VOYAGE_REQUIRED', 'STD.310.PORTS_REQUIRED',
];

describe('remaining EDI 310 required fields', () => {
  it('extracts ocean document identity fields and passes their hard gates', () => {
    const invoice = parse310(GOLDEN_310, categorize);
    expect(invoice).toMatchObject({
      invoiceNumber: 'INV310002', shipmentReferences: ['BOOK310001'],
      containerNumbers: ['MSCU1234567'], vesselVoyage: 'VOY42', portCodes: ['USLAX', 'CNSHA'],
    });
    expect(evaluateInvoice(invoice).gateFailures.filter((gate) => keys.includes(gate.criterionKey))).toEqual([]);
  });

  it.each([
    ['invoice number', 'B3**INV310002*', 'B3***'],
    ['reference', 'N9*BM*BOOK310001~', ''],
    ['container', 'N7*MSCU*1234567~', ''],
    ['vessel/voyage', 'V1*IMO1234567*VESSEL**VOY42~', ''],
    ['second port', 'R4*D*CNSHA~', ''],
  ])('rejects a 310 missing %s', (_name, present, absent) => {
    const result = evaluateInvoice(parse310(GOLDEN_310.replace(present, absent), categorize));
    expect(result.outcome).toBe('REJECTED_REWORK');
    expect(result.gateFailures.some((gate) => keys.includes(gate.criterionKey))).toBe(true);
  });

  it('does not apply 310-only gates to a 210', () => {
    expect(evaluateInvoice(parse210(GOLDEN_210, categorize)).gateFailures.filter(
      (gate) => keys.includes(gate.criterionKey),
    )).toEqual([]);
  });
});
