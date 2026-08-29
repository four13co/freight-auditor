import { Decimal } from 'decimal.js';

/**
 * Pure validation for the three ways a claim reaches a terminal outcome
 * (P5.A.4), each ending recovery activity on the claim:
 *
 * - FULL_RECOVERY: a recovery_event whose cumulative total (prior + this
 *   event) equals amount_claimed exactly -- same "reaches the claimed
 *   amount" rule as validatePartialRecovery's isFinal (P5.A.3/#171), lifted
 *   here as the terminal case rather than an incidental flag.
 * - DENIAL: the carrier has flatly refused the claim; nothing is or will be
 *   recovered (amountRecovered must not be provided).
 * - WRITE_OFF: pursuit of the remainder stops for reasons other than a
 *   flat refusal (uneconomical to continue, statute expired, etc).
 *   amountRecovered is OPTIONAL here -- a write-off can follow a nonzero
 *   partial recovery (some money came in, the rest is abandoned) or none
 *   at all (nothing was ever recovered, but this was a deliberate stop,
 *   not a denial).
 *
 * A claim already in a terminal status cannot be resolved again -- these
 * are true terminal states, unlike the ongoing accumulation
 * validatePartialRecovery supports.
 */
export type ClaimResolutionKind = 'FULL_RECOVERY' | 'DENIAL' | 'WRITE_OFF';

export interface ClaimRow {
  id: string;
  amountClaimed: string;
  currency: string | null;
  status: string;
}

export interface ValidatedClaimResolution {
  claimId: string;
  kind: ClaimResolutionKind;
  amountRecovered: string | null;
  currency: string | null;
  newStatus: 'recovered' | 'denied' | 'written_off';
}

const TERMINAL_STATUSES = new Set(['recovered', 'denied', 'written_off']);

export class ClaimResolutionError extends Error {
  constructor(
    readonly code:
      | 'ALREADY_TERMINAL'
      | 'NON_POSITIVE_AMOUNT'
      | 'MISSING_CURRENCY'
      | 'MIXED_CURRENCY'
      | 'FULL_RECOVERY_AMOUNT_MISMATCH'
      | 'WRITE_OFF_EXCEEDS_CLAIMED_AMOUNT'
      | 'DENIAL_MUST_NOT_INCLUDE_AMOUNT',
  ) {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'ClaimResolutionError';
  }
}

export function validateClaimResolution(
  claim: ClaimRow,
  kind: ClaimResolutionKind,
  priorRecoveredTotal: string,
  amountRecovered: string | null,
  currency: string | null,
): ValidatedClaimResolution {
  if (TERMINAL_STATUSES.has(claim.status)) throw new ClaimResolutionError('ALREADY_TERMINAL');

  if (kind === 'DENIAL') {
    if (amountRecovered !== null) throw new ClaimResolutionError('DENIAL_MUST_NOT_INCLUDE_AMOUNT');
    return { claimId: claim.id, kind, amountRecovered: null, currency: null, newStatus: 'denied' };
  }

  if (kind === 'WRITE_OFF' && amountRecovered === null) {
    return { claimId: claim.id, kind, amountRecovered: null, currency: null, newStatus: 'written_off' };
  }

  if (amountRecovered === null) throw new ClaimResolutionError('NON_POSITIVE_AMOUNT');
  if (new Decimal(amountRecovered).lte(0)) throw new ClaimResolutionError('NON_POSITIVE_AMOUNT');
  if (currency === null) throw new ClaimResolutionError('MISSING_CURRENCY');
  if (claim.currency !== null && currency !== claim.currency) throw new ClaimResolutionError('MIXED_CURRENCY');

  const cumulative = new Decimal(priorRecoveredTotal).plus(amountRecovered);
  const claimed = new Decimal(claim.amountClaimed);

  if (kind === 'FULL_RECOVERY') {
    if (!cumulative.eq(claimed)) throw new ClaimResolutionError('FULL_RECOVERY_AMOUNT_MISMATCH');
    return { claimId: claim.id, kind, amountRecovered, currency, newStatus: 'recovered' };
  }

  // WRITE_OFF with a nonzero final recovery
  if (cumulative.gte(claimed)) throw new ClaimResolutionError('WRITE_OFF_EXCEEDS_CLAIMED_AMOUNT');
  return { claimId: claim.id, kind, amountRecovered, currency, newStatus: 'written_off' };
}
