import { describe, it, expect } from 'vitest';
import {
  validateClaimableDispute,
  ClaimableDisputeError,
  type ClaimableDisputeRow,
} from '../../src/modules/claims/validate-claimable-dispute.js';

const base: ClaimableDisputeRow = {
  id: 'd1111111-1111-1111-1111-111111111111',
  status: 'accepted',
  amountClaimed: '125.5000',
  currency: 'USD',
};

describe('validateClaimableDispute', () => {
  it('accepts an accepted dispute with a positive claimed amount', () => {
    const result = validateClaimableDispute(base);
    expect(result).toEqual({
      disputeId: base.id,
      amountClaimed: '125.5000',
      currency: 'USD',
    });
  });

  it('rejects a dispute not in accepted status', () => {
    expect(() => validateClaimableDispute({ ...base, status: 'sent' }))
      .toThrow(ClaimableDisputeError);
    try {
      validateClaimableDispute({ ...base, status: 'draft' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ClaimableDisputeError);
      expect((err as ClaimableDisputeError).code).toBe('NOT_ACCEPTED');
    }
  });

  it('rejects a dispute with a null claimed amount', () => {
    try {
      validateClaimableDispute({ ...base, amountClaimed: null });
      expect.unreachable();
    } catch (err) {
      expect((err as ClaimableDisputeError).code).toBe('MISSING_AMOUNT');
    }
  });

  it('rejects a dispute with a null currency', () => {
    try {
      validateClaimableDispute({ ...base, currency: null });
      expect.unreachable();
    } catch (err) {
      expect((err as ClaimableDisputeError).code).toBe('MISSING_CURRENCY');
    }
  });

  it('rejects a dispute with a zero claimed amount', () => {
    try {
      validateClaimableDispute({ ...base, amountClaimed: '0.0000' });
      expect.unreachable();
    } catch (err) {
      expect((err as ClaimableDisputeError).code).toBe('NON_POSITIVE_AMOUNT');
    }
  });

  it('rejects a dispute with a negative claimed amount', () => {
    try {
      validateClaimableDispute({ ...base, amountClaimed: '-10.0000' });
      expect.unreachable();
    } catch (err) {
      expect((err as ClaimableDisputeError).code).toBe('NON_POSITIVE_AMOUNT');
    }
  });

  it('rejects a dispute that already has been claimed', () => {
    try {
      validateClaimableDispute({ ...base }, { alreadyClaimed: true });
      expect.unreachable();
    } catch (err) {
      expect((err as ClaimableDisputeError).code).toBe('ALREADY_CLAIMED');
    }
  });
});
