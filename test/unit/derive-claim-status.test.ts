import { describe, it, expect } from 'vitest';
import { deriveClaimStatus, CLAIM_TERMINAL_EVENTS } from '../../src/modules/claims/derive-claim-status.js';

describe('deriveClaimStatus', () => {
  it('derives open when no terminal event exists', () => {
    const result = deriveClaimStatus('c1', [], '0.0000', 'open');
    expect(result.derivedStatus).toBe('open');
    expect(result.matches).toBe(true);
  });

  it('derives recovered from a claim.recovered event', () => {
    const result = deriveClaimStatus('c1', [{ event: CLAIM_TERMINAL_EVENTS.RECOVERED, recordedAt: '2026-08-28T00:00:00Z' }], '500.0000', 'recovered');
    expect(result.derivedStatus).toBe('recovered');
    expect(result.matches).toBe(true);
  });

  it('derives denied from a claim.denied event', () => {
    const result = deriveClaimStatus('c1', [{ event: CLAIM_TERMINAL_EVENTS.DENIED, recordedAt: '2026-08-28T00:00:00Z' }], '0.0000', 'denied');
    expect(result.derivedStatus).toBe('denied');
    expect(result.matches).toBe(true);
  });

  it('derives written_off from a claim.written_off event, distinct from denial despite both having zero recovery', () => {
    const denied = deriveClaimStatus('c1', [{ event: CLAIM_TERMINAL_EVENTS.DENIED, recordedAt: '2026-08-28T00:00:00Z' }], '0.0000', 'denied');
    const writtenOff = deriveClaimStatus('c2', [{ event: CLAIM_TERMINAL_EVENTS.WRITTEN_OFF, recordedAt: '2026-08-28T00:00:00Z' }], '0.0000', 'written_off');
    expect(denied.derivedStatus).toBe('denied');
    expect(writtenOff.derivedStatus).toBe('written_off');
  });

  it('ignores non-terminal events when deriving', () => {
    const result = deriveClaimStatus('c1', [
      { event: 'claim.created', recordedAt: '2026-08-28T00:00:00Z' },
      { event: 'recovery_event.recorded', recordedAt: '2026-08-28T01:00:00Z' },
    ], '100.0000', 'open');
    expect(result.derivedStatus).toBe('open');
  });

  it('picks the latest terminal event by recordedAt regardless of input order', () => {
    const result = deriveClaimStatus('c1', [
      { event: CLAIM_TERMINAL_EVENTS.WRITTEN_OFF, recordedAt: '2026-08-28T02:00:00Z' },
      { event: CLAIM_TERMINAL_EVENTS.RECOVERED, recordedAt: '2026-08-28T01:00:00Z' },
    ], '500.0000', 'written_off');
    expect(result.derivedStatus).toBe('written_off');
  });

  it('reports a mismatch when the stored status disagrees with the derived one', () => {
    const result = deriveClaimStatus('c1', [{ event: CLAIM_TERMINAL_EVENTS.RECOVERED, recordedAt: '2026-08-28T00:00:00Z' }], '500.0000', 'open');
    expect(result.matches).toBe(false);
    expect(result.derivedStatus).toBe('recovered');
    expect(result.storedStatus).toBe('open');
  });

  it('formats cumulativeRecovered to 4 decimal places', () => {
    const result = deriveClaimStatus('c1', [], '100', 'open');
    expect(result.cumulativeRecovered).toBe('100.0000');
  });
});
