import { describe, it, expect } from 'vitest';
import { deriveClaimStatus, CLAIM_TERMINAL_EVENTS } from '../../src/modules/claims/derive-claim-status.js';

describe('deriveClaimStatus', () => {
  it('derives "open" when there are no terminal events', () => {
    const result = deriveClaimStatus({ storedStatus: 'open', terminalEvents: [], recoveryEvents: [] });
    expect(result).toEqual({ derivedStatus: 'open', cumulativeRecovered: '0.0000', matches: true });
  });

  it('derives "recovered" from a claim.recovered terminal event', () => {
    const result = deriveClaimStatus({
      storedStatus: 'recovered',
      terminalEvents: [{ event: CLAIM_TERMINAL_EVENTS.recovered, recordedAt: new Date('2026-01-01T00:00:00Z') }],
      recoveryEvents: [{ amountRecovered: '500.0000' }],
    });
    expect(result).toEqual({ derivedStatus: 'recovered', cumulativeRecovered: '500.0000', matches: true });
  });

  it('distinguishes a denial (zero events, claim.denied) from a zero-recovery write-off (zero events, claim.written_off)', () => {
    const denied = deriveClaimStatus({
      storedStatus: 'denied',
      terminalEvents: [{ event: CLAIM_TERMINAL_EVENTS.denied, recordedAt: new Date('2026-01-01T00:00:00Z') }],
      recoveryEvents: [],
    });
    expect(denied.derivedStatus).toBe('denied');

    const writtenOff = deriveClaimStatus({
      storedStatus: 'written_off',
      terminalEvents: [{ event: CLAIM_TERMINAL_EVENTS.written_off, recordedAt: new Date('2026-01-01T00:00:00Z') }],
      recoveryEvents: [],
    });
    expect(writtenOff.derivedStatus).toBe('written_off');
  });

  it('when 2+ terminal events exist for a claim, the one with the latest recordedAt (a real Date, not a string) wins', () => {
    const result = deriveClaimStatus({
      storedStatus: 'written_off',
      terminalEvents: [
        { event: CLAIM_TERMINAL_EVENTS.denied, recordedAt: new Date('2026-01-01T00:00:00Z') },
        { event: CLAIM_TERMINAL_EVENTS.written_off, recordedAt: new Date('2026-01-05T00:00:00Z') },
      ],
      recoveryEvents: [],
    });
    expect(result.derivedStatus).toBe('written_off');
  });

  it('order of terminalEvents in the input array does not affect the latest-wins result', () => {
    const result = deriveClaimStatus({
      storedStatus: 'recovered',
      terminalEvents: [
        { event: CLAIM_TERMINAL_EVENTS.recovered, recordedAt: new Date('2026-01-10T00:00:00Z') },
        { event: CLAIM_TERMINAL_EVENTS.denied, recordedAt: new Date('2026-01-02T00:00:00Z') },
        { event: CLAIM_TERMINAL_EVENTS.written_off, recordedAt: new Date('2026-01-06T00:00:00Z') },
      ],
      recoveryEvents: [],
    });
    expect(result.derivedStatus).toBe('recovered');
  });

  it('sums multiple recovery_event rows via decimal.js, not floating point', () => {
    const result = deriveClaimStatus({
      storedStatus: 'open',
      terminalEvents: [],
      recoveryEvents: [{ amountRecovered: '0.1' }, { amountRecovered: '0.2' }],
    });
    expect(result.cumulativeRecovered).toBe('0.3000');
  });

  it('reports a mismatch (matches: false) when derived status differs from stored status', () => {
    const result = deriveClaimStatus({
      storedStatus: 'open',
      terminalEvents: [{ event: CLAIM_TERMINAL_EVENTS.recovered, recordedAt: new Date('2026-01-01T00:00:00Z') }],
      recoveryEvents: [],
    });
    expect(result.matches).toBe(false);
    expect(result.derivedStatus).toBe('recovered');
  });

  it('ignores an unrecognized event name rather than throwing', () => {
    const result = deriveClaimStatus({
      storedStatus: 'open',
      terminalEvents: [{ event: 'claim.follow_up_sent', recordedAt: new Date('2026-01-01T00:00:00Z') }],
      recoveryEvents: [],
    });
    expect(result.derivedStatus).toBe('open');
  });
});
