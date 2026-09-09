import { Decimal } from 'decimal.js';

/**
 * 86e367qzt: the amount/currency validation sequence duplicated across
 * validate-claimable-dispute.ts, validate-claim-resolution.ts, and
 * validate-partial-recovery.ts -- non-positive amount, missing currency,
 * and (when the caller has an existing currency to compare a new one
 * against) mixed currency. Each caller supplies its own throw callbacks so
 * the distinct error class/code per call site is unchanged; passing
 * existingCurrency: null skips the mixed-currency check entirely (there is
 * nothing to compare against), as validate-claimable-dispute.ts's single
 * dispute amount/currency pair does.
 */
export interface RecoveryAmountAndCurrencyErrors {
  onNonPositiveAmount: () => never;
  onMissingCurrency: () => never;
  onMixedCurrency: () => never;
}

export function validateRecoveryAmountAndCurrency(
  amount: string,
  currency: string | null,
  existingCurrency: string | null,
  errors: RecoveryAmountAndCurrencyErrors,
): { amount: string; currency: string } {
  if (new Decimal(amount).lte(0)) errors.onNonPositiveAmount();
  if (currency === null) errors.onMissingCurrency();
  if (existingCurrency !== null && currency !== existingCurrency) errors.onMixedCurrency();

  return { amount, currency };
}
