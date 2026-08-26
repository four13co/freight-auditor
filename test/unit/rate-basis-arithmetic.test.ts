import { describe, expect, it } from 'vitest';
import type { ParsedInvoice } from '../../src/modules/ingestion/charge-fact.js';
import { parse210 } from '../../src/modules/ingestion/parse-210.js';
import { evaluateInvoice } from '../../src/modules/evaluator/evaluate-invoice.js';

const envelope = (total: string) =>
  'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *260703*1200*U*00401*000000001*0*P*>~' +
  `GS*IM*S*R*20260703*1200*1*X*004010~ST*210*1~B3**INV-RATE*SHIP-RATE****${total}****ABCD~`;
const tail = '~SE*4*1~';
const categorize = () => 'LINEHAUL';

function finding(invoice: ParsedInvoice) {
  return evaluateInvoice(invoice).findings.find(
    (item) => item.criterionKey === 'STD.RATE_BASIS_ARITHMETIC',
  )?.result;
}

describe('intra-line rate × basis arithmetic', () => {
  it('parses L1-02 rate and L1-17 basis as canonical decimals', () => {
    const parsed = parse210(`${envelope('25.00')}L1*1*2.50**25.00*************10${tail}`, categorize);
    expect(parsed.charges[0]).toMatchObject({ rate: '2.5000', basis: '10.0000', amount: '25.0000' });
    expect(finding(parsed)).toBe('CONFORMED');
  });

  it('flags mismatched arithmetic without IEEE float behavior', () => {
    const parsed = parse210(`${envelope('0.32')}L1*1*0.10**0.32*************3${tail}`, categorize);
    expect(finding(parsed)).toBe('VARIANCE');
  });

  it('is unassessable when arithmetic fields are absent or incomplete', () => {
    const absent = parse210(`${envelope('25.00')}L1*1***25.00****400${tail}`, categorize);
    const incomplete = parse210(`${envelope('25.00')}L1*1*2.50**25.00****400${tail}`, categorize);
    expect(finding(absent)).toBe('UNASSESSABLE');
    expect(finding(incomplete)).toBe('UNASSESSABLE');
  });

  it('allows the declared one-cent absolute tolerance', () => {
    const parsed = parse210(`${envelope('25.01')}L1*1*2.50**25.01*************10${tail}`, categorize);
    expect(finding(parsed)).toBe('CONFORMED');
  });
});
