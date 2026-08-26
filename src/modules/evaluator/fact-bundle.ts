import { Decimal } from 'decimal.js';
import type { FactBundle } from '../rule-engine/ast.js';
import type { ParsedInvoice } from '../ingestion/charge-fact.js';
import type { ContractRate } from '../rate-engine/rate-lookup.js';

/**
 * Contract-scoped facts resolved by the caller BEFORE building the bundle
 * (Master Spec §5 step [2] FETCH PLAN — the rate lookup is I/O, so it happens
 * outside the pure fact-bundle/eval boundary, same as external-index values
 * would). `linehaulRate: null` means the invoice's linehaul charge amount(s)
 * exist but no contracted rate was found for this contract (UNASSESSABLE, per
 * §10 — never guessed); omit the whole object to skip CONTRACT-tier facts
 * entirely (a STANDARD-only audit run).
 */
export interface ContractFacts {
  linehaulRate?: ContractRate | null;
  duplicateInvoice?: boolean;
  shipmentReferenceMatch?: boolean;
}

export interface CoverageMarker {
  chargeIndex: number;
  code: 'INCOMPLETE_RATE_BASIS' | 'FUEL_WITHOUT_RATE_BASIS' | 'MISSING_CHARGE_IDENTITY';
  missingFields: string[];
}

/** Deterministic discovery inputs: gaps on charges that otherwise passed structural validation. */
export function findCoverageMarkers(inv: ParsedInvoice): CoverageMarker[] {
  const markers: CoverageMarker[] = [];
  inv.charges.forEach((charge, chargeIndex) => {
    const hasRate = charge.rate !== undefined;
    const hasBasis = charge.basis !== undefined;
    if (hasRate !== hasBasis) {
      markers.push({
        chargeIndex,
        code: 'INCOMPLETE_RATE_BASIS',
        missingFields: [hasRate ? 'basis' : 'rate'],
      });
    } else if (charge.category === 'FUEL' && !hasRate && !hasBasis) {
      markers.push({ chargeIndex, code: 'FUEL_WITHOUT_RATE_BASIS', missingFields: ['rate', 'basis'] });
    }
    if (!charge.code?.trim() && !charge.rawDescription?.trim()) {
      markers.push({ chargeIndex, code: 'MISSING_CHARGE_IDENTITY', missingFields: ['code', 'rawDescription'] });
    }
  });
  return markers;
}

/**
 * Resolve a parsed invoice into the flat fact bundle the interpreter reads
 * (Master Spec §3.2 — facts are resolved into a bundle BEFORE eval; the eval
 * itself does no I/O and no derivation beyond the AST). Keeping resolution here,
 * outside eval, is what keeps eval pure and total.
 */
export function buildFactBundle(inv: ParsedInvoice, contract?: ContractFacts): FactBundle {
  const lineSum = inv.footing?.lineSum ?? '0.0000';
  const declaredTotal = inv.footing?.declaredTotal;
  const allCurrenciesStated = inv.charges.every((c) => c.currency !== '');
  const allAmountsStated = inv.charges.every((c) => c.amount !== undefined);
  const quarantinedCount = inv.charges.filter((c) => c.quarantined).length;
  const hasFuel = inv.charges.some((c) => c.category === 'FUEL');
  const rateBasisCharges = inv.charges.filter((c) => c.rate !== undefined || c.basis !== undefined);
  const rateBasisArithmeticMatches = rateBasisCharges.length === 0 || rateBasisCharges.some(
    (c) => c.rate === undefined || c.basis === undefined || c.amount === undefined,
  )
    ? undefined
    : rateBasisCharges.every((c) => new Decimal(c.rate!).times(c.basis!).minus(c.amount!).abs().lte('0.01'));
  const currencies = inv.charges.map((charge) => charge.currency);
  const firstCurrency = currencies[0];
  const coverageMarkers = findCoverageMarkers(inv);

  const bundle: FactBundle = {
    declared_total: declaredTotal === undefined ? undefined : { amount: declaredTotal, currency: inv.headerCurrency ?? '' },
    line_sum: { amount: new Decimal(lineSum).toFixed(4), currency: inv.headerCurrency ?? '' },
    all_currencies_stated: allCurrenciesStated,
    all_amounts_stated: allAmountsStated,
    charge_count: inv.charges.length,
    quarantined_count: quarantinedCount,
    has_fuel_category: hasFuel,
    duplicate_invoice: contract?.duplicateInvoice,
    shipment_reference_match: contract?.shipmentReferenceMatch,
    rate_basis_arithmetic_matches: rateBasisArithmeticMatches,
    required_210_invoice_number: inv.transactionSet !== '210' || Boolean(inv.invoiceNumber?.trim()),
    required_210_shipment_id: inv.transactionSet !== '210' || Boolean(inv.shipmentReferences?.length),
    required_210_scac: inv.transactionSet !== '210' || Boolean(inv.carrierCode?.trim()),
    required_310_invoice_number: inv.transactionSet !== '310' || Boolean(inv.invoiceNumber?.trim()),
    required_310_reference: inv.transactionSet !== '310' || Boolean(inv.shipmentReferences?.length),
    required_310_container: inv.transactionSet !== '310' || Boolean(inv.containerNumbers?.length),
    required_310_vessel_voyage: inv.transactionSet !== '310' || Boolean(inv.vesselVoyage?.trim()),
    required_310_ports: inv.transactionSet !== '310' || (inv.portCodes?.length ?? 0) >= 2,
    required_310_charge_identity: inv.transactionSet !== '310' || inv.charges.every(
      (charge) => Boolean(charge.code?.trim() || charge.rawDescription?.trim()),
    ),
    valid_310_currency_codes: inv.transactionSet !== '310' || currencies.every(
      (currency) => /^[A-Z]{3}$/.test(currency),
    ),
    consistent_310_charge_currencies: inv.transactionSet !== '310'
      ? undefined
      : firstCurrency === undefined || currencies.every((currency) => currency === firstCurrency),
    suspicious_missing_data_count: coverageMarkers.length,
  };

  if (contract?.linehaulRate !== undefined) {
    // Sum all LINEHAUL charges on the invoice — the billed side of the variance
    // comparison. Excludes quarantined charges (an unparseable/uncategorized
    // amount can't be compared; the STANDARD gates already handle that defect).
    const linehaulCharges = inv.charges.filter((c) => c.category === 'LINEHAUL' && !c.quarantined && c.amount !== undefined);
    const hasLinehaulCharge = linehaulCharges.length > 0;
    // 86e25urnj: ocean (310) supports per-charge currency (never USD defaulted,
    // §13), so a single invoice can legitimately carry multiple LINEHAUL
    // charges in different currencies. Summing them into one Decimal before
    // checking this would produce a magnitude that doesn't correspond to any
    // single currency, tagged with an arbitrary one (the first charge's) — a
    // silently wrong number. Require all contributing charges to share the
    // same currency before computing the sum at all; otherwise the fact is
    // absent, same as any other unassessable-input case (§10: never guessed).
    const linehaulCurrenciesConsistent =
      hasLinehaulCharge && linehaulCharges.every((c) => c.currency === linehaulCharges[0]!.currency);
    const billedCurrency = linehaulCurrenciesConsistent ? linehaulCharges[0]!.currency : undefined;
    const billedLinehaul = linehaulCurrenciesConsistent
      ? linehaulCharges.reduce((acc, c) => acc.plus(new Decimal(c.amount!)), new Decimal(0))
      : undefined;
    const rateCurrency = contract.linehaulRate === null ? undefined : contract.linehaulRate.currency;

    bundle.billed_linehaul =
      billedLinehaul === undefined ? undefined : { amount: billedLinehaul.toFixed(4), currency: billedCurrency! };
    bundle.contract_linehaul_rate =
      contract.linehaulRate === null
        ? undefined
        : { amount: contract.linehaulRate.amount, currency: rateCurrency! };
    // 86e25ug1p: the interpreter's `compare` op:approx compares money amounts
    // only, never currency (see toDecimal in interpreter.ts) — so a naive
    // approx comparison silently treats 500 USD and 500 EUR as CONFORMED.
    // The criterion's AST gates its money comparison behind a `require` on
    // this fact — and `require` treats only undefined/'' as absent, NOT
    // `false` — so this must be `true` or omitted entirely, never `false`.
    // A currency mismatch (or either side unstated) leaves it absent, which
    // correctly resolves the whole criterion to UNASSESSABLE rather than
    // falling through into a magnitude-only comparison.
    const currenciesStatedAndEqual =
      billedCurrency !== undefined && rateCurrency !== undefined && billedCurrency !== '' && rateCurrency !== ''
        ? billedCurrency === rateCurrency
        : false;
    bundle.linehaul_currencies_match = currenciesStatedAndEqual ? true : undefined;
  }

  return bundle;
}
