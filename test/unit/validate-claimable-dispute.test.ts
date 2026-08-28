import { describe, it, expect } from 'vitest';
import { validateClaimableDispute, ClaimableDisputeError } from '../../src/modules/claims/validate-claimable-dispute.js';

const baseRow = { id: 'dispute-1', status: 'accepted', amountClaimed: '500.0000', currency: 'USD' };

describe('validateClaimableDispute', () => {
  it('returns the claimable fields for an accepted dispute with a positive amount and currency', () => {
    const result = validateClaimableDispute(baseRow);
    expect(result).toEqual({ disputeId: 'dispute-1', amountClaimed: '500.0000', currency: 'USD' });
  });

  it.each(['draft', 'sent', 'in_progress', 'rejected', 'closed'])('rejects a %s dispute as NOT_ACCEPTED', (status) => {
    try {
      validateClaimableDispute({ ...baseRow, status });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ClaimableDisputeError);
      expect((err as ClaimableDisputeError).code).toBe('NOT_ACCEPTED');
    }
  });

  it('rejects a dispute with no amount_claimed as MISSING_AMOUNT', () => {
    try {
      validateClaimableDispute({ ...baseRow, amountClaimed: null });
      expect.unreachable();
    } catch (err) {
      expect((err as ClaimableDisputeError).code).toBe('MISSING_AMOUNT');
    }
  });

  it('rejects a dispute with no currency as MISSING_CURRENCY', () => {
    try {
      validateClaimableDispute({ ...baseRow, currency: null });
      expect.unreachable();
    } catch (err) {
      expect((err as ClaimableDisputeError).code).toBe('MISSING_CURRENCY');
    }
  });

  it.each(['0.0000', '-100.0000'])('rejects a non-positive amount (%s) as NON_POSITIVE_AMOUNT', (amountClaimed) => {
    try {
      validateClaimableDispute({ ...baseRow, amountClaimed });
      expect.unreachable();
    } catch (err) {
      expect((err as ClaimableDisputeError).code).toBe('NON_POSITIVE_AMOUNT');
    }
  });
});
