import { describe, expect, it } from 'vitest';
import {
  isPaymentAuthorizationAction,
  PAYMENT_AUTHORIZATION_ACTIONS,
} from '../../src/modules/payments/payment-authorization-action.js';

describe('payment authorization action mapping', () => {
  it('accepts approve and hold', () => {
    expect(isPaymentAuthorizationAction('approve')).toBe(true);
    expect(isPaymentAuthorizationAction('hold')).toBe(true);
  });

  it('rejects do_not_pay -- that decision is system-generated, never an analyst POST', () => {
    expect(isPaymentAuthorizationAction('do_not_pay')).toBe(false);
  });

  it('rejects unknown strings, non-strings, and undefined', () => {
    expect(isPaymentAuthorizationAction('short_pay')).toBe(false);
    expect(isPaymentAuthorizationAction(42)).toBe(false);
    expect(isPaymentAuthorizationAction(undefined)).toBe(false);
    expect(isPaymentAuthorizationAction(null)).toBe(false);
  });

  it('maps every action to its own literal payment_gate_action value', () => {
    expect(PAYMENT_AUTHORIZATION_ACTIONS.approve).toBe('approve');
    expect(PAYMENT_AUTHORIZATION_ACTIONS.hold).toBe('hold');
  });
});
