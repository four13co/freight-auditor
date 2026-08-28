import { Decimal } from 'decimal.js';

/**
 * Pure composition of a short-pay amount (P4.B.3): pay the invoice total
 * minus the accepted OVERCHARGE variance, withholding only what is already
 * an analyst-accepted, disputable overcharge -- never a proposed or
 * rejected one, and never an UNDERCHARGE (the platform owes the carrier
 * more in that case, not less, mirroring validate-disputable-findings.ts's
 * same exclusion for dispute creation).
 *
 * A candidate set spanning more than one currency is rejected rather than
 * guessed at (this platform never pre-converts currency, §6), same
 * discipline as validate-disputable-findings.ts. A withheld amount that
 * would equal or exceed the invoice total is also rejected: paying zero or
 * less isn't a short pay, it's a do-not-pay decision (P4.B.4's boundary).
 */
export interface ChargeFactRow {
  amount: string;
  currency: string | null;
}

export interface AcceptedOverchargeFindingRow {
  id: string;
  currency: string | null;
  varianceAmount: string | null;
}

export interface ShortPayDecision {
  amountToPay: string;
  withheldAmount: string;
  currency: string;
  findingIds: string[];
}

export class ShortPayDecisionError extends Error {
  constructor(
    readonly code:
      | 'EMPTY_SET'
      | 'MIXED_CURRENCY'
      | 'MISSING_AMOUNT'
      | 'WITHHELD_EXCEEDS_TOTAL',
  ) {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'ShortPayDecisionError';
  }
}

export function composeShortPayDecision(
  chargeFacts: readonly ChargeFactRow[],
  acceptedOverchargeFindings: readonly AcceptedOverchargeFindingRow[],
): ShortPayDecision {
  if (acceptedOverchargeFindings.length === 0) throw new ShortPayDecisionError('EMPTY_SET');

  for (const f of acceptedOverchargeFindings) {
    if (f.currency === null || f.varianceAmount === null) throw new ShortPayDecisionError('MISSING_AMOUNT');
  }
  for (const c of chargeFacts) {
    if (c.currency === null) throw new ShortPayDecisionError('MISSING_AMOUNT');
  }

  const currencies = new Set([
    ...chargeFacts.map((c) => c.currency),
    ...acceptedOverchargeFindings.map((f) => f.currency),
  ]);
  if (currencies.size > 1) throw new ShortPayDecisionError('MIXED_CURRENCY');
  const currency = [...currencies][0]!;

  const invoiceTotal = chargeFacts.reduce((sum, c) => sum.plus(new Decimal(c.amount)), new Decimal(0));
  const sorted = [...acceptedOverchargeFindings].sort((a, b) => a.id.localeCompare(b.id));
  const withheld = sorted.reduce((sum, f) => sum.plus(new Decimal(f.varianceAmount!)), new Decimal(0));

  if (withheld.gte(invoiceTotal)) throw new ShortPayDecisionError('WITHHELD_EXCEEDS_TOTAL');

  return {
    amountToPay: invoiceTotal.minus(withheld).toFixed(4),
    withheldAmount: withheld.toFixed(4),
    currency,
    findingIds: sorted.map((f) => f.id),
  };
}
