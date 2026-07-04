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

export const PARSER_310_VERSION = '310-v1';

/**
 * EDI 310 (Freight Receipt & Invoice, ocean) adapter (Master Spec §13).
 *
 * Confirms GS01=IO. Ocean charges are per-charge currency (C3 + L1-20) and MUST
 * NOT default to USD — defaulting is a correctness bug (§13 rabbit hole). Each
 * L1 charge carries its own currency; we read C3 as the interchange default and
 * override per-charge from L1-20 when present, but never silently assume USD:
 * if neither is stated, the charge currency is empty and the STANDARD gate flags
 * "currency not stated".
 *
 * Category via crosswalk boundary; unknown codes quarantined.
 */
export function parse310(raw: string, categorize: Categorize): ParsedInvoice {
  const ix: X12Interchange = parseX12(raw);
  assertFunctionalGroup(ix, 'IO');

  const b3 = firstSegment(ix, 'B3');
  const invoiceNumber = el(b3, 2);
  const declaredTotal = el(b3, 7);

  // C3 = currency segment; C3-01 is the interchange-level currency, if declared.
  const c3 = firstSegment(ix, 'C3');
  const interchangeCurrency = el(c3, 1); // may be undefined — do NOT default to USD

  const charges: NormalizedCharge[] = [];
  const quarantinedCodes: string[] = [];

  for (const l1 of segmentsByTag(ix, 'L1')) {
    const amount = money(el(l1, 4)); // L1-04 = charge amount
    const code = el(l1, 8); // L1-08 = special charge code
    const rawDescription = el(l1, 12); // L1-12 = description
    const perChargeCurrency = el(l1, 20); // L1-20 = per-charge currency (ocean)
    // Per-charge wins; fall back to the interchange currency; NEVER default USD.
    const currency = perChargeCurrency ?? interchangeCurrency ?? '';
    const category = categorize(code);
    // A charge is quarantined if its code can't be categorized OR its amount
    // couldn't be parsed as money (a malformed L1-04 is a structural defect,
    // never guessed as 0 — the STD.AMOUNT_STATED gate rejects the invoice).
    const quarantined = (code !== undefined && category === undefined) || amount === undefined;
    if (code !== undefined && category === undefined) quarantinedCodes.push(code);
    charges.push({
      code,
      x12Element: 'L1',
      category,
      quarantined,
      amount,
      currency,
      rawDescription,
      sourceLoop: 'L1',
    });
  }

  return {
    transactionSet: '310',
    parserVersion: PARSER_310_VERSION,
    invoiceNumber,
    headerCurrency: interchangeCurrency,
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
