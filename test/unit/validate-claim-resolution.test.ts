import { describe, it, expect } from 'vitest';
import {
  validateClaimResolution,
  ClaimResolutionError,
  type ClaimRow,
} from '../../src/modules/claims/validate-claim-resolution.js';

const claim: ClaimRow = { id: 'c1', amountClaimed: '500.0000', currency: 'USD', status: 'open' };

describe('validateClaimResolution', () => {
  it('accepts a full recovery whose cumulative total exactly matches the claimed amount', () => {
    const result = validateClaimResolution(claim, 'FULL_RECOVERY', '300.0000', '200.0000', 'USD');
    expect(result).toEqual({ claimId: 'c1', kind: 'FULL_RECOVERY', amountRecovered: '200.0000', currency: 'USD', newStatus: 'recovered' });
  });

  it('rejects a full recovery that falls short of the claimed amount', () => {
    try {
      validateClaimResolution(claim, 'FULL_RECOVERY', '0.0000', '400.0000', 'USD');
      expect.unreachable();
    } catch (err) {
      expect((err as ClaimResolutionError).code).toBe('FULL_RECOVERY_AMOUNT_MISMATCH');
    }
  });

  it('rejects a full recovery that overshoots the claimed amount', () => {
    try {
      validateClaimResolution(claim, 'FULL_RECOVERY', '0.0000', '600.0000', 'USD');
      expect.unreachable();
    } catch (err) {
      expect((err as ClaimResolutionError).code).toBe('FULL_RECOVERY_AMOUNT_MISMATCH');
    }
  });

  it('accepts a denial with no amount', () => {
    const result = validateClaimResolution(claim, 'DENIAL', '0.0000', null, null);
    expect(result).toEqual({ claimId: 'c1', kind: 'DENIAL', amountRecovered: null, currency: null, newStatus: 'denied' });
  });

  it('rejects a denial that includes an amount', () => {
    try {
      validateClaimResolution(claim, 'DENIAL', '0.0000', '10.0000', 'USD');
      expect.unreachable();
    } catch (err) {
      expect((err as ClaimResolutionError).code).toBe('DENIAL_MUST_NOT_INCLUDE_AMOUNT');
    }
  });

  it('accepts a write-off with no amount recovered', () => {
    const result = validateClaimResolution(claim, 'WRITE_OFF', '0.0000', null, null);
    expect(result.newStatus).toBe('written_off');
    expect(result.amountRecovered).toBeNull();
  });

  it('accepts a write-off with a nonzero partial recovery below the claimed amount', () => {
    const result = validateClaimResolution(claim, 'WRITE_OFF', '100.0000', '150.0000', 'USD');
    expect(result.newStatus).toBe('written_off');
    expect(result.amountRecovered).toBe('150.0000');
  });

  it('rejects a write-off whose cumulative total reaches the claimed amount', () => {
    try {
      validateClaimResolution(claim, 'WRITE_OFF', '400.0000', '100.0000', 'USD');
      expect.unreachable();
    } catch (err) {
      expect((err as ClaimResolutionError).code).toBe('WRITE_OFF_EXCEEDS_CLAIMED_AMOUNT');
    }
  });

  it('rejects a zero amount for a write-off with an amount supplied', () => {
    try {
      validateClaimResolution(claim, 'WRITE_OFF', '0.0000', '0.0000', 'USD');
      expect.unreachable();
    } catch (err) {
      expect((err as ClaimResolutionError).code).toBe('NON_POSITIVE_AMOUNT');
    }
  });

  it('rejects resolving a claim already in a terminal status', () => {
    const terminalClaim: ClaimRow = { ...claim, status: 'recovered' };
    try {
      validateClaimResolution(terminalClaim, 'DENIAL', '0.0000', null, null);
      expect.unreachable();
    } catch (err) {
      expect((err as ClaimResolutionError).code).toBe('ALREADY_TERMINAL');
    }
  });

  it('rejects a currency mismatch on a full recovery', () => {
    try {
      validateClaimResolution(claim, 'FULL_RECOVERY', '0.0000', '500.0000', 'CAD');
      expect.unreachable();
    } catch (err) {
      expect((err as ClaimResolutionError).code).toBe('MIXED_CURRENCY');
    }
  });
});
