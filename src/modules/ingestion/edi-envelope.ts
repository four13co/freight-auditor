import {
  parseX12,
  segmentsByTag,
  firstSegment,
  el,
  type X12Interchange,
  type X12Segment,
} from './x12.js';
import {
  money,
  sumMoney,
  type Categorize,
  type NormalizedCharge,
} from './charge-fact.js';

/**
 * Shared parsing skeleton for the 210 (motor) and 310 (ocean) adapters (Master
 * Spec §13). Both transaction sets share an identical envelope + charge-loop
 * shape; the one genuine divergence — currency resolution — stays outside this
 * module and is injected per-transaction-set via `resolveCurrency` (86e25tdgt).
 */

/**
 * Parse the X12 envelope and assert its functional group code (GS01). Subsumes
 * `parseX12()` + the group check both adapters previously duplicated
 * byte-for-byte.
 */
export function parseEdiEnvelope(raw: string, expectedGroup: string): X12Interchange {
  const ix = parseX12(raw);
  const gs = firstSegment(ix, 'GS');
  const gs01 = el(gs, 1);
  if (gs01 !== undefined && gs01 !== expectedGroup) {
    throw new Error(`expected GS01=${expectedGroup} for this transaction set, got ${gs01}`);
  }
  return ix;
}

/** B3 header fields common to both transaction sets. */
export function readB3Header(ix: X12Interchange): { invoiceNumber?: string; declaredTotal?: string } {
  const b3 = firstSegment(ix, 'B3');
  return {
    invoiceNumber: el(b3, 2), // B3-02 = invoice number
    declaredTotal: el(b3, 7), // B3-07 = total charges
  };
}

/** Trim, discard blanks, and deduplicate source references without changing their display casing. */
export function normalizeReferences(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const references: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    references.push(normalized);
  }
  return references;
}

/**
 * Resolve a charge line's currency, given its raw L1 segment. Injected per
 * transaction-set: 210 returns a fixed header currency; 310 reads C3/L1-20 and
 * must never default to USD (§13 rabbit hole) — this divergence is
 * deliberately NOT unified (per the shape's rabbit-hole guard).
 */
export type ResolveCurrency = (l1: X12Segment) => string | undefined;

/**
 * Build normalized charge facts from the L1 loop — identical across both
 * transaction sets except for currency resolution and `sourceLoop` label.
 */
export function buildCharges(
  ix: X12Interchange,
  categorize: Categorize,
  resolveCurrency: ResolveCurrency,
  sourceLoop: string,
): { charges: NormalizedCharge[]; quarantinedCodes: string[] } {
  const charges: NormalizedCharge[] = [];
  const quarantinedCodes: string[] = [];

  for (const l1 of segmentsByTag(ix, 'L1')) {
    const amount = money(el(l1, 4)); // L1-04 = charge amount
    const code = el(l1, 8); // L1-08 = special charge code
    const rawDescription = el(l1, 12); // L1-12 = description
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
      currency: resolveCurrency(l1) ?? '',
      rawDescription,
      sourceLoop,
    });
  }

  return { charges, quarantinedCodes };
}

/** Reconcile the footing triple (declared total vs. summed line charges, §5). */
export function buildFooting(declaredTotal: string | undefined, charges: NormalizedCharge[]) {
  return {
    declaredTotal: declaredTotal === undefined ? undefined : money(declaredTotal),
    lineSum: sumMoney(charges.map((c) => c.amount)),
  };
}
