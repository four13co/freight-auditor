/**
 * Golden EDI fixtures for Phase 1 (Master Spec §13). Hand-checked: the expected
 * charge facts and footing are asserted in the acceptance tests. Delimiters:
 * element '*', segment '~', component '>'. The ISA envelope carries exactly 16
 * elements so the delimiter reader can discover the terminators from ISA alone.
 */

// ISA (16 elements) + GS. GS01=IM marks a 210 (motor) functional group.
const ISA_210 =
  'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *260703*1200*U*00401*000000001*0*P*>~' +
  'GS*IM*SENDER*RECEIVER*20260703*1200*1*X*004010~';

// GS01=IO marks a 310 (ocean) functional group.
const ISA_310 =
  'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *260703*1200*U*00401*000000002*0*P*>~' +
  'GS*IO*SENDER*RECEIVER*20260703*1200*2*X*004010~';

/**
 * GOLDEN 210 — a well-formed motor invoice that FOOTS.
 * B3-07 declared total = 1250.00; two L1 charges: 1000.00 (LINEHAUL) + 250.00 (FUEL).
 * Σ = 1250.00 → foots. B3-11 currency = USD.
 */
// L1 element positions (X12), read by el(seg,N)=elements[N-1]: L1-01 line no,
// L1-04 charge amount, L1-08 special charge code, L1-12 description. The '*'
// fillers place each value at its real element index. For 310, L1-20 = per-charge
// currency. Element layout for a charge line:
//   L1 *01 *02 *03 *04(amount) *05 *06 *07 *08(code) *09 *10 *11 *12(desc) ...
export const GOLDEN_210 =
  ISA_210 +
  'ST*210*0001~' +
  'B3**INV210001*****1250.00***USD~' +
  'L1*1***1000.00****400****Linehaul~' +
  'L1*2***250.00****405****Fuel Surcharge~' +
  'SE*5*0001~';

export const GOLDEN_210_EXPECTED = {
  invoiceNumber: 'INV210001',
  declaredTotal: '1250.0000',
  lineSum: '1250.0000',
  charges: [
    { code: '400', amount: '1000.0000', currency: 'USD', category: 'LINEHAUL' },
    { code: '405', amount: '250.0000', currency: 'USD', category: 'FUEL' },
  ],
};

/**
 * GOLDEN 310 — a well-formed ocean invoice with PER-CHARGE currency (never USD
 * defaulted). C3 interchange currency = USD, but each L1 states its own via
 * L1-20: 3000.00 USD (OCEAN_FREIGHT) + 150.00 EUR (DOC_FEE). Foots to B3-07.
 */
export const GOLDEN_310 =
  ISA_310 +
  'ST*310*0002~' +
  'B3**INV310002*****3150.00***~' +
  'C3*USD~' +
  'L1*1***3000.00****500****Ocean Freight********USD~' +
  'L1*2***150.00****510****Documentation Fee********EUR~' +
  'SE*6*0002~';

export const GOLDEN_310_EXPECTED = {
  invoiceNumber: 'INV310002',
  declaredTotal: '3150.0000',
  lineSum: '3150.0000',
  charges: [
    { code: '500', amount: '3000.0000', currency: 'USD', category: 'OCEAN_FREIGHT' },
    { code: '510', amount: '150.0000', currency: 'EUR', category: 'DOC_FEE' },
  ],
};

/**
 * MALFORMED 210 — does NOT foot: B3-07 says 1250.00 but the lines sum to 1050.00
 * (200 short). Should REJECT_REWORK on the footing gate. It still has valid
 * currency + charges, so footing is the SOLE gate failure.
 */
export const MALFORMED_210_NOFOOT =
  ISA_210 +
  'ST*210*0003~' +
  'B3**INV210003*****1250.00***USD~' +
  'L1*1***800.00****400****Linehaul~' +
  'L1*2***250.00****405****Fuel Surcharge~' +
  'SE*5*0003~';

/**
 * MALFORMED 310 — currency NOT stated on a charge (no C3, no L1-20). Ocean must
 * state currency; this should REJECT_REWORK on the currency-stated gate.
 */
export const MALFORMED_310_NOCURRENCY =
  ISA_310 +
  'ST*310*0004~' +
  'B3**INV310004*****500.00***~' +
  'L1*1***500.00****500****Ocean Freight~' +
  'SE*4*0004~';

/**
 * MALFORMED 210 — a charge line's amount (L1-04) is non-numeric garbage
 * ("N/A") rather than a number. Before the STD.AMOUNT_STATED fix this crashed
 * the parser (an uncaught decimal.js DecimalError); it must now quarantine the
 * charge and REJECT_REWORK on the new gate instead (86e25tdce).
 */
export const MALFORMED_210_BADAMOUNT =
  ISA_210 +
  'ST*210*0005~' +
  'B3**INV210005*****1250.00***USD~' +
  'L1*1***N/A****400****Linehaul~' +
  'L1*2***250.00****405****Fuel Surcharge~' +
  'SE*5*0005~';

/**
 * MALFORMED 210 — a charge line's amount (L1-04) is blank/absent rather than
 * merely non-numeric. Before 86e2t15kh, money() defaulted a missing amount to
 * '0.0000', silently valuing the charge at zero and letting it pass the
 * STD.AMOUNT_STATED gate; it must now quarantine the charge and REJECT_REWORK,
 * same as the non-numeric case above.
 */
export const MALFORMED_210_MISSINGAMOUNT =
  ISA_210 +
  'ST*210*0006~' +
  'B3**INV210006*****1250.00***USD~' +
  'L1*1*******400****Linehaul~' +
  'L1*2***250.00****405****Fuel Surcharge~' +
  'SE*5*0006~';

/**
 * MALFORMED 310 — the B3-07 declared total is non-numeric garbage ("N/A")
 * rather than a number. money() no longer throws on this (916cab7), so
 * parse310() must degrade footing.declaredTotal to undefined without
 * throwing — the same way a legitimately-absent B3 segment already does
 * (86e25ujx3). The one L1 charge is otherwise well-formed and unaffected.
 */
export const MALFORMED_310_BADAMOUNT =
  ISA_310 +
  'ST*310*0007~' +
  'B3**INV310007*****N/A***~' +
  'C3*USD~' +
  'L1*1***500.00****500****Ocean Freight********USD~' +
  'SE*5*0007~';

/**
 * MISMATCHED GROUP — a 210-shaped envelope (ST*210) whose GS01 says IO (the 310
 * group code) instead of IM. Both parsers assert their own expected GS01; this
 * exercises the negative case for parse210 (86e25tdgt: refactor must preserve
 * the same error, raised from a shared envelope helper).
 */
export const MISMATCHED_GROUP_210 =
  ISA_310 +
  'ST*210*0006~' +
  'B3**INV210006*****100.00***USD~' +
  'L1*1***100.00****400****Linehaul~' +
  'SE*4*0006~';

/**
 * Mirror for 310: an ocean-shaped envelope (ST*310) whose GS01 says IM instead
 * of IO.
 */
export const MISMATCHED_GROUP_310 =
  ISA_210 +
  'ST*310*0007~' +
  'B3**INV310007*****100.00***~' +
  'C3*USD~' +
  'L1*1***100.00****500****Ocean Freight~' +
  'SE*5*0007~';

/**
 * MIXED-CURRENCY LINEHAUL — a 310 (ocean) invoice with TWO LINEHAUL-categorized
 * (code 400) charges in different per-charge currencies (L1-20): 1000.00 USD +
 * 1000.00 EUR. Ocean legitimately supports per-charge currency (never USD
 * defaulted, §13), so a single invoice can carry a split-currency LINEHAUL
 * total (86e25urnj: buildFactBundle must not sum these into one Decimal tagged
 * with only the first charge's currency).
 */
export const MIXED_CURRENCY_LINEHAUL_310 =
  ISA_310 +
  'ST*310*0008~' +
  'B3**INV310008*****2000.00***~' +
  'C3*USD~' +
  'L1*1***1000.00****400****Linehaul Leg 1********USD~' +
  'L1*2***1000.00****400****Linehaul Leg 2********EUR~' +
  'SE*6*0008~';

// 86e2xcnja: the stub crosswalk this test categorizer used to redefine
// locally now has one shared definition (stub-crosswalk.ts) -- imported
// here rather than triplicated across this file, ingest-invoice.ts, and
// seed-fullstack-e2e-fixture.mjs. testCategorize is kept as its own
// exported name/signature (many test files already import it) — mirrors
// the DB crosswalk boundary (§13): audit logic reads canonical categories,
// never raw codes. Unknown codes return undefined → the parser quarantines
// them.
export { stubCategorize as testCategorize } from '../../src/modules/ingestion/stub-crosswalk.js';
