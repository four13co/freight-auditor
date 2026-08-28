import { Decimal } from 'decimal.js';

/**
 * The three terminal claim.status values #174's resolveClaim writes, and the
 * audit_event names it writes alongside each ('claim.<status>'). Duplicated
 * here as string literals (not imported from resolve-claim.ts, #174, still
 * open/unmerged) -- a looser coupling than the shape-matching pattern used
 * elsewhere this session. If this drifts, the failure is loud (a resolved
 * claim derives as 'open'), not silent.
 */
export const CLAIM_TERMINAL_EVENTS = {
  recovered: 'claim.recovered',
  denied: 'claim.denied',
  written_off: 'claim.written_off',
} as const;

export type ClaimTerminalStatus = keyof typeof CLAIM_TERMINAL_EVENTS;
const TERMINAL_EVENT_TO_STATUS = new Map<string, ClaimTerminalStatus>(
  Object.entries(CLAIM_TERMINAL_EVENTS).map(([status, event]) => [event, status as ClaimTerminalStatus]),
);

export interface TerminalAuditEvent {
  event: string;
  /** A real Date, not a string -- pg returns timestamptz columns as Date, never a string. */
  recordedAt: Date;
}

export interface RecoveryEventAmount {
  amountRecovered: string;
}

export interface DeriveClaimStatusInput {
  storedStatus: string;
  terminalEvents: TerminalAuditEvent[];
  recoveryEvents: RecoveryEventAmount[];
}

export interface DeriveClaimStatusResult {
  derivedStatus: string;
  cumulativeRecovered: string;
  matches: boolean;
}

/**
 * Recomputes what a claim's status SHOULD be from its append-only event
 * history (P5.A.5, 86e2zfj62) and compares it against the stored status.
 * Reconciliation only -- never writes a fix; a mismatch is reported via
 * `matches: false` for the caller (or a later reconciliation item) to act on.
 *
 * recovery_event alone can't distinguish a denial from a zero-recovery
 * write-off -- both have zero events -- so the latest terminal audit_event
 * is the discriminator. When more than one terminal event exists for a
 * claim (should not happen once #174's ALREADY_TERMINAL guard is in place,
 * but the ledger is the source of truth, not that guard), the one with the
 * latest recordedAt wins.
 */
export function deriveClaimStatus(input: DeriveClaimStatusInput): DeriveClaimStatusResult {
  const cumulativeRecovered = input.recoveryEvents
    .reduce((sum, event) => sum.plus(new Decimal(event.amountRecovered)), new Decimal(0))
    .toFixed(4);

  const knownTerminalEvents = input.terminalEvents.filter((event) => TERMINAL_EVENT_TO_STATUS.has(event.event));
  const latest = knownTerminalEvents.reduce<TerminalAuditEvent | null>((latest, event) => {
    if (!latest || event.recordedAt.getTime() > latest.recordedAt.getTime()) return event;
    return latest;
  }, null);

  const derivedStatus = latest ? TERMINAL_EVENT_TO_STATUS.get(latest.event)! : 'open';

  return {
    derivedStatus,
    cumulativeRecovered,
    matches: derivedStatus === input.storedStatus,
  };
}
