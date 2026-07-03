import {
  parseX12,
  segmentsByTag,
  firstSegment,
  el,
  type X12Interchange,
} from './x12.js';
import {
  money,
  sumMoney,
  type Categorize,
  type NormalizedCharge,
  type ParsedInvoice,
} from './charge-fact.js';

export const PARSER_210_VERSION = '210-v1';

/**
 * EDI 210 (Motor Carrier Freight Details & Invoice) adapter (Master Spec §13).
 *
 * Confirms GS01=IM, reads the B3 header (declared total + invoice number), and
 * normalizes the L0/L1 charge detail into charge facts. The L1 segment carries
 * the charge amount (L1-04 in cents-or-dollars per the carrier; here dollars),
 * the special-charge code (L1-08), and description (L1-12). Category is resolved
 * via the crosswalk boundary — unknown L1-08 codes are quarantined, never guessed.
 *
 * Footing (§5): B3-07 declared total vs. Σ L1 charges — the gate decides tolerance.
 */
export function parse210(raw: string, categorize: Categorize): ParsedInvoice {
  const ix: X12Interchange = parseX12(raw);
  assertFunctionalGroup(ix, 'IM');

  const b3 = firstSegment(ix, 'B3');
  const invoiceNumber = el(b3, 2); // B3-02 = invoice number
  const declaredTotal = el(b3, 7); // B3-07 = total charges
  const headerCurrency = el(b3, 11) ?? 'USD'; // B3-11 = currency; 210 declares one

  const charges: NormalizedCharge[] = [];
  const quarantinedCodes: string[] = [];

  for (const l1 of segmentsByTag(ix, 'L1')) {
    const amount = money(el(l1, 4)); // L1-04 = charge amount
    const code = el(l1, 8); // L1-08 = special charge code
    const rawDescription = el(l1, 12); // L1-12 = description
    const category = categorize(code);
    const quarantined = code !== undefined && category === undefined;
    if (quarantined && code) quarantinedCodes.push(code);
    charges.push({
      code,
      x12Element: 'L1',
      category,
      quarantined,
      amount,
      currency: headerCurrency,
      rawDescription,
      sourceLoop: 'L0/L1',
    });
  }

  return {
    transactionSet: '210',
    parserVersion: PARSER_210_VERSION,
    invoiceNumber,
    headerCurrency,
    charges,
    footing: {
      declaredTotal: declaredTotal === undefined ? undefined : money(declaredTotal),
      lineSum: sumMoney(charges.map((c) => c.amount)),
    },
    quarantinedCodes,
  };
}

function assertFunctionalGroup(ix: X12Interchange, expected: string): void {
  const gs = firstSegment(ix, 'GS');
  const gs01 = el(gs, 1);
  if (gs01 !== undefined && gs01 !== expected) {
    throw new Error(`expected GS01=${expected} for this transaction set, got ${gs01}`);
  }
}
