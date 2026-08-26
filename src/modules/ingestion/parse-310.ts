import { firstSegment, segmentsByTag, el } from './x12.js';
import { type Categorize, type ParsedInvoice } from './charge-fact.js';
import { parseEdiEnvelope, readB3Header, buildCharges, buildFooting, normalizeReferences } from './edi-envelope.js';

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
  const ix = parseEdiEnvelope(raw, 'IO');
  const { invoiceNumber, declaredTotal } = readB3Header(ix);
  const shipmentReferences = normalizeReferences(segmentsByTag(ix, 'N9').map((segment) => el(segment, 2)));

  // C3 = currency segment; C3-01 is the interchange-level currency, if declared.
  const c3 = firstSegment(ix, 'C3');
  const interchangeCurrency = el(c3, 1); // may be undefined — do NOT default to USD

  // Per-charge (L1-20) wins; fall back to the interchange currency; NEVER default USD.
  const { charges, quarantinedCodes } = buildCharges(
    ix,
    categorize,
    (l1) => el(l1, 20) ?? interchangeCurrency,
    'L1',
  );

  return {
    transactionSet: '310',
    parserVersion: PARSER_310_VERSION,
    invoiceNumber,
    shipmentReferences,
    headerCurrency: interchangeCurrency,
    charges,
    footing: buildFooting(declaredTotal, charges),
    quarantinedCodes,
  };
}
