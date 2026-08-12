import { Decimal } from 'decimal.js';

/**
 * The normalized billed-charge model (Master Spec §6.5). Both the 210 (motor)
 * and 310 (ocean) adapters emit this shape — mode-specific logic lives in the
 * adapters, never in a forked downstream model.
 *
 * Money is carried as a string in canonical form (via decimal.js) so it never
 * touches IEEE float, and currency is per-charge (never defaulted — §6, a 310
 * correctness requirement).
 *
 * `category` is the CANONICAL category resolved through the crosswalk (§13). The
 * adapter does not guess it from the raw X12 element; a categorize callback (the
 * crosswalk boundary) fills it, and unknown codes are quarantined (category
 * null + quarantined=true) rather than mislabeled.
 */
export interface NormalizedCharge {
  code?: string; // raw carrier charge code
  x12Element?: string; // source element, e.g. "L108"
  category?: string; // canonical, via crosswalk — undefined if unresolved
  quarantined: boolean; // true when the code could not be resolved to a category, OR the amount was unparseable
  amount: string | undefined; // decimal string, 4dp canonical; undefined if the raw value couldn't be parsed as money (never guessed — a malformed amount fails the STD.AMOUNT_STATED gate instead of silently becoming 0)
  currency: string; // ISO-4217, per charge — never defaulted
  basis?: string;
  rate?: string;
  rawDescription?: string;
  sourceLoop?: string;
}

/** Header-level facts a parsed invoice carries besides its charges. */
export interface ParsedInvoice {
  transactionSet: '210' | '310';
  parserVersion: string;
  invoiceNumber?: string;
  /** Header currency where the set declares one (210 often does; 310 is per-charge). */
  headerCurrency?: string;
  charges: NormalizedCharge[];
  /**
   * The reconciled footing triple for the gate (§5). For 210 this is the B3/L3
   * declared total vs. the summed line charges; carriers routinely violate it,
   * so the evaluator (not the parser) decides tolerance.
   */
  footing?: {
    declaredTotal?: string; // e.g. B3 amount
    lineSum: string; // Σ line charges
  };
  /** Codes seen but not resolvable — surfaced so the caller can quarantine loudly. */
  quarantinedCodes: string[];
}

/** A crosswalk categorizer: raw code → canonical category (or undefined if unknown). */
export type Categorize = (code: string | undefined) => string | undefined;

/**
 * Canonicalize a money string to 4dp via decimal.js (no float drift, §5).
 * Returns undefined if `raw` is missing, blank, or not parseable as a number —
 * a missing or malformed carrier value (e.g. absent, or "N/A") is reported
 * honestly as unstated, never guessed as 0 or any other value (§10: "a missing
 * value reported honestly is correct; a guessed value is a defect").
 */
export function money(raw: string | number | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  try {
    return new Decimal(raw).toFixed(4);
  } catch {
    return undefined;
  }
}

/** Sum decimal money strings exactly. Unparseable (undefined) values are excluded from the sum. */
export function sumMoney(values: (string | undefined)[]): string {
  return values
    .filter((v): v is string => v !== undefined)
    .reduce((acc, v) => acc.plus(new Decimal(v)), new Decimal(0))
    .toFixed(4);
}
