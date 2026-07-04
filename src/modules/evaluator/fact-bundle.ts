import { Decimal } from 'decimal.js';
import type { FactBundle } from '../rule-engine/ast.js';
import type { ParsedInvoice } from '../ingestion/charge-fact.js';

/**
 * Resolve a parsed invoice into the flat fact bundle the interpreter reads
 * (Master Spec §3.2 — facts are resolved into a bundle BEFORE eval; the eval
 * itself does no I/O and no derivation beyond the AST). Keeping resolution here,
 * outside eval, is what keeps eval pure and total.
 */
export function buildFactBundle(inv: ParsedInvoice): FactBundle {
  const lineSum = inv.footing?.lineSum ?? '0.0000';
  const declaredTotal = inv.footing?.declaredTotal;
  const allCurrenciesStated = inv.charges.every((c) => c.currency !== '');
  const allAmountsStated = inv.charges.every((c) => c.amount !== undefined);
  const quarantinedCount = inv.charges.filter((c) => c.quarantined).length;
  const hasFuel = inv.charges.some((c) => c.category === 'FUEL');

  return {
    declared_total: declaredTotal === undefined ? undefined : { amount: declaredTotal, currency: inv.headerCurrency ?? '' },
    line_sum: { amount: new Decimal(lineSum).toFixed(4), currency: inv.headerCurrency ?? '' },
    all_currencies_stated: allCurrenciesStated,
    all_amounts_stated: allAmountsStated,
    charge_count: inv.charges.length,
    quarantined_count: quarantinedCount,
    has_fuel_category: hasFuel,
  };
}
