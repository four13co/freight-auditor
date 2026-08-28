import { Decimal } from 'decimal.js';

/**
 * Derives a claim's status purely from its append-only event history
 * (P5.A.5): the terminal audit_event for the claim (if any), plus the
 * cumulative recovery_event total. Independent of whatever resolveClaim
 * (P5.A.4/#174) wrote directly to claim.status -- this is a reconciliation
 * primitive that recomputes what the status SHOULD be from history, to
 * verify it against what IS stored.
 *
 * recovery_event alone cannot distinguish a denial from a zero-recovery
 * write-off (both have zero recovery_event rows) -- audit_event is the
 * discriminator, since resolveClaim writes a distinct
 * claim.recovered/claim.denied/claim.written_off event for each outcome.
 *
 * These event-name constants currently duplicate the string literals
 * inlined in resolve-claim.ts (#174, unmerged); once both land, #174
 * should import these rather than keep its own literals.
 */
export const CLAIM_TERMINAL_EVENTS = {
  RECOVERED: 'claim.recovered',
  DENIED: 'claim.denied',
  WRITTEN_OFF: 'claim.written_off',
} as const;

export type ClaimTerminalEvent = (typeof CLAIM_TERMINAL_EVENTS)[keyof typeof CLAIM_TERMINAL_EVENTS];

export interface ClaimAuditEventRow {
  event: string;
  recordedAt: string;
}

export interface DerivedClaimStatus {
  claimId: string;
  derivedStatus: 'open' | 'recovered' | 'denied' | 'written_off';
  cumulativeRecovered: string;
  storedStatus: string;
  matches: boolean;
}

const TERMINAL_EVENT_TO_STATUS: Record<ClaimTerminalEvent, 'recovered' | 'denied' | 'written_off'> = {
  [CLAIM_TERMINAL_EVENTS.RECOVERED]: 'recovered',
  [CLAIM_TERMINAL_EVENTS.DENIED]: 'denied',
  [CLAIM_TERMINAL_EVENTS.WRITTEN_OFF]: 'written_off',
};

function isTerminalEvent(event: string): event is ClaimTerminalEvent {
  return event === CLAIM_TERMINAL_EVENTS.RECOVERED || event === CLAIM_TERMINAL_EVENTS.DENIED || event === CLAIM_TERMINAL_EVENTS.WRITTEN_OFF;
}

/**
 * auditEvents should be every audit_event row for this claim (entity =
 * 'claim', entity_id = claimId), in any order -- this sorts by recordedAt
 * itself so the LATEST terminal event wins (a claim cannot un-terminate,
 * but if the ledger ever carries more than one terminal event for the same
 * claim, that is itself a reconciliation finding this function surfaces
 * via `matches: false`, not something it silently resolves by picking the
 * first one).
 */
export function deriveClaimStatus(
  claimId: string,
  auditEvents: readonly ClaimAuditEventRow[],
  cumulativeRecovered: string,
  storedStatus: string,
): DerivedClaimStatus {
  const terminalEvents = auditEvents
    .filter((e) => isTerminalEvent(e.event))
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));

  const latest = terminalEvents.at(-1);
  const derivedStatus = latest ? TERMINAL_EVENT_TO_STATUS[latest.event as ClaimTerminalEvent] : 'open';

  return {
    claimId,
    derivedStatus,
    cumulativeRecovered: new Decimal(cumulativeRecovered).toFixed(4),
    storedStatus,
    matches: derivedStatus === storedStatus,
  };
}
