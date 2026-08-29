import { describe, it, expect } from 'vitest';
import {
  validatePartialRecovery,
  PartialRecoveryError,
  type ClaimRow,
} from '../../src/modules/claims/validate-partial-recovery.js';

const claim: ClaimRow = { id: 'c1111111-1111-1111-1111-111111111111', amountClaimed: '500.0000', currency: 'USD' };

describe('validatePartialRecovery', () => {
  it('accepts a first partial recovery below the claimed amount', () => {
    const result = validatePartialRecovery(claim, '200.0000', 'USD', '0.0000');
    expect(result).toEqual({
      claimId: claim.id, amountRecovered: '200.0000', currency: 'USD',
      cumulativeRecovered: '200.0000', isFinal: false,
    });
  });

  it('accepts a subsequent partial recovery that reaches exactly the claimed amount', () => {
    const result = validatePartialRecovery(claim, '300.0000', 'USD', '200.0000');
    expect(result.cumulativeRecovered).toBe('500.0000');
    expect(result.isFinal).toBe(true);
  });

  it('rejects a recovery that would exceed the claimed amount', () => {
    try {
      validatePartialRecovery(claim, '301.0000', 'USD', '200.0000');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PartialRecoveryError);
      expect((err as PartialRecoveryError).code).toBe('EXCEEDS_CLAIMED_AMOUNT');
    }
  });

  it('rejects a zero amount', () => {
    try {
      validatePartialRecovery(claim, '0.0000', 'USD', '0.0000');
      expect.unreachable();
    } catch (err) {
      expect((err as PartialRecoveryError).code).toBe('NON_POSITIVE_AMOUNT');
    }
  });

  it('rejects a negative amount', () => {
    try {
      validatePartialRecovery(claim, '-50.0000', 'USD', '0.0000');
      expect.unreachable();
    } catch (err) {
      expect((err as PartialRecoveryError).code).toBe('NON_POSITIVE_AMOUNT');
    }
  });

  it('rejects a null currency', () => {
    try {
      validatePartialRecovery(claim, '100.0000', null, '0.0000');
      expect.unreachable();
    } catch (err) {
      expect((err as PartialRecoveryError).code).toBe('MISSING_CURRENCY');
    }
  });

  it('rejects a currency that does not match the claim', () => {
    try {
      validatePartialRecovery(claim, '100.0000', 'CAD', '0.0000');
      expect.unreachable();
    } catch (err) {
      expect((err as PartialRecoveryError).code).toBe('MIXED_CURRENCY');
    }
  });

  it('allows any currency when the claim itself has no currency recorded', () => {
    const noCurrencyClaim: ClaimRow = { ...claim, currency: null };
    const result = validatePartialRecovery(noCurrencyClaim, '100.0000', 'EUR', '0.0000');
    expect(result.currency).toBe('EUR');
  });
});
