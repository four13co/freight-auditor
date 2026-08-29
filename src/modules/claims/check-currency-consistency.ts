/**
 * Read-side currency-consistency sweep over a claim's recovery_event rows
 * (P5.A.6) -- distinct from the per-write MIXED_CURRENCY guards already in
 * validatePartialRecovery (P5.A.3/#171) and validateClaimResolution
 * (P5.A.4/#174): those reject a NEW event at write time; this verifies the
 * FULL existing history of a claim is internally consistent, catching drift
 * from any write path this platform doesn't yet route through those
 * guards (a manual DB correction, a future writer that forgets to call
 * them, replay from an older event set, etc).
 *
 * recovery_event.currency is nullable in schema (0008: char(3), no NOT
 * NULL) even though every writer this session has built always supplies
 * one. A NULL currency on a financial event is itself a data-integrity
 * problem, not something to silently exclude from the sweep -- excluding
 * it would let a NULL-currency row hide from reconciliation entirely. It
 * is therefore surfaced as its own finding (nullCurrencyEventIds), and a
 * claim with any such row is never reported consistent regardless of what
 * its other rows look like.
 */
export interface RecoveryEventCurrencyRow {
  id: string;
  currency: string | null;
}

export interface CurrencyConsistencyResult {
  claimId: string;
  claimCurrency: string | null;
  consistent: boolean;
  currencies: string[];
  nullCurrencyEventIds: string[];
  mismatchedEventIds: string[];
}

export function checkCurrencyConsistency(
  claimId: string,
  claimCurrency: string | null,
  recoveryEvents: readonly RecoveryEventCurrencyRow[],
): CurrencyConsistencyResult {
  const nullCurrencyEventIds = recoveryEvents.filter((e) => e.currency === null).map((e) => e.id);
  const nonNull = recoveryEvents.filter((e): e is { id: string; currency: string } => e.currency !== null);

  const currencies = [...new Set(nonNull.map((e) => e.currency))].sort();
  const mismatchedEventIds = claimCurrency === null
    ? []
    : nonNull.filter((e) => e.currency !== claimCurrency).map((e) => e.id);

  const consistent = nullCurrencyEventIds.length === 0 && currencies.length <= 1 && mismatchedEventIds.length === 0;

  return { claimId, claimCurrency, consistent, currencies, nullCurrencyEventIds, mismatchedEventIds };
}
