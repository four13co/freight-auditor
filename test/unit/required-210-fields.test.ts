import { describe, expect, it } from 'vitest';
import { parse210 } from '../../src/modules/ingestion/parse-210.js';
import { parse310 } from '../../src/modules/ingestion/parse-310.js';
import { evaluateInvoice } from '../../src/modules/evaluator/evaluate-invoice.js';
import { GOLDEN_210, GOLDEN_310 } from '../fixtures/edi-golden.js';

const categorize = (code: string | undefined) => code;
const gateKeys = [
  'STD.210.INVOICE_NUMBER_REQUIRED',
  'STD.210.SHIPMENT_ID_REQUIRED',
  'STD.210.SCAC_REQUIRED',
];

describe('remaining EDI 210 required fields', () => {
  it('extracts and accepts B3-02 invoice, B3-03 shipment ID, and B3-11 SCAC', () => {
    const invoice = parse210(GOLDEN_210, categorize);
    expect(invoice).toMatchObject({
      invoiceNumber: 'INV210001', shipmentReferences: ['SHIP210001'], carrierCode: 'ABCD',
    });
    const result = evaluateInvoice(invoice);
    expect(result.gateFailures.filter((gate) => gateKeys.includes(gate.criterionKey))).toEqual([]);
  });

  it.each([
    ['invoice number', 'B3**INV210001*', 'B3***'],
    ['shipment ID', '*SHIP210001****1250.00', '*****1250.00'],
    ['SCAC', '****ABCD~', '*****~'],
  ])('rejects a 210 missing %s', (_name, present, absent) => {
    const result = evaluateInvoice(parse210(GOLDEN_210.replace(present, absent), categorize));
    expect(result.outcome).toBe('REJECTED_REWORK');
    expect(result.gateFailures.some((gate) => gateKeys.includes(gate.criterionKey))).toBe(true);
  });

  it('does not apply 210-only requirements to a 310', () => {
    const result = evaluateInvoice(parse310(GOLDEN_310, categorize));
    expect(result.gateFailures.filter((gate) => gateKeys.includes(gate.criterionKey))).toEqual([]);
  });
});
