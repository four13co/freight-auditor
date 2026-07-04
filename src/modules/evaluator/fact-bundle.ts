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
  linehaulRate: ContractRate | null;
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

  const bundle: FactBundle = {
    declared_total: declaredTotal === undefined ? undefined : { amount: declaredTotal, currency: inv.headerCurrency ?? '' },
    line_sum: { amount: new Decimal(lineSum).toFixed(4), currency: inv.headerCurrency ?? '' },
    all_currencies_stated: allCurrenciesStated,
    all_amounts_stated: allAmountsStated,
    charge_count: inv.charges.length,
    quarantined_count: quarantinedCount,
    has_fuel_category: hasFuel,
  };

  if (contract !== undefined) {
    // Sum all LINEHAUL charges on the invoice — the billed side of the variance
    // comparison. Excludes quarantined charges (an unparseable/uncategorized
    // amount can't be compared; the STANDARD gates already handle that defect).
    const linehaulCharges = inv.charges.filter((c) => c.category === 'LINEHAUL' && !c.quarantined && c.amount !== undefined);
    const billedLinehaul = linehaulCharges.reduce((acc, c) => acc.plus(new Decimal(c.amount!)), new Decimal(0));
    const hasLinehaulCharge = linehaulCharges.length > 0;
    const billedCurrency = hasLinehaulCharge ? linehaulCharges[0]!.currency : undefined;
    const rateCurrency = contract.linehaulRate === null ? undefined : contract.linehaulRate.currency;

    bundle.billed_linehaul = hasLinehaulCharge
      ? { amount: billedLinehaul.toFixed(4), currency: billedCurrency! }
      : undefined;
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
