import { describe, expect, it } from 'vitest';
import {
  CLAIM_TERMINAL_STATUSES,
  CLAIM_TERMINAL_EVENT_NAMES,
  CLAIM_TERMINAL_EVENTS,
  isClaimTerminalStatus,
} from '../../src/modules/claims/claim-status.js';

describe('claim-status shared vocabulary', () => {
  it('defines exactly the three terminal statuses', () => {
    expect([...CLAIM_TERMINAL_STATUSES].sort()).toEqual(['denied', 'recovered', 'written_off']);
  });

  it('maps each terminal status to its own audit_event name', () => {
    expect(CLAIM_TERMINAL_EVENTS).toEqual({
      recovered: 'claim.recovered',
      denied: 'claim.denied',
      written_off: 'claim.written_off',
    });
  });

  it('derives the event-name list from the same map, so the two can never drift', () => {
    expect([...CLAIM_TERMINAL_EVENT_NAMES].sort()).toEqual(
      Object.values(CLAIM_TERMINAL_EVENTS).sort(),
    );
  });

  it('isClaimTerminalStatus recognizes a terminal status and rejects a non-terminal one', () => {
    expect(isClaimTerminalStatus('recovered')).toBe(true);
    expect(isClaimTerminalStatus('denied')).toBe(true);
    expect(isClaimTerminalStatus('written_off')).toBe(true);
    expect(isClaimTerminalStatus('open')).toBe(false);
    expect(isClaimTerminalStatus('anything-else')).toBe(false);
  });
});
