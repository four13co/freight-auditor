import { firstSegment, el } from './x12.js';
import { type Categorize, type ParsedInvoice } from './charge-fact.js';
import { parseEdiEnvelope, readB3Header, buildCharges, buildFooting, normalizeReferences } from './edi-envelope.js';

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
  const ix = parseEdiEnvelope(raw, 'IM');
  const { invoiceNumber, declaredTotal } = readB3Header(ix);

  const b3 = firstSegment(ix, 'B3');
  const shipmentReferences = normalizeReferences([el(b3, 3)]); // B3-03 = shipment identification number
  const carrierCode = el(b3, 11); // B3-11 = Standard Carrier Alpha Code (SCAC)
  // The 210 does not carry per-line currency like the 310; this platform's
  // North-American motor profile uses USD. B3-11 is SCAC, never currency.
  const headerCurrency = 'USD';

  // 210 applies the single header currency to every charge line.
  const { charges, quarantinedCodes } = buildCharges(ix, categorize, () => headerCurrency, 'L0/L1');

  return {
    transactionSet: '210',
    parserVersion: PARSER_210_VERSION,
    invoiceNumber,
    shipmentReferences,
    carrierCode,
    headerCurrency,
    charges,
    footing: buildFooting(declaredTotal, charges),
    quarantinedCodes,
  };
}
