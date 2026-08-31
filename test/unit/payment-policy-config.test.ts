import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAYMENT_POLICY,
  parsePaymentPolicyConfig,
  PaymentPolicyValidationError,
} from '../../src/modules/payments/payment-policy-config.js';

const clientId = '11111111-1111-4111-8111-111111111111';
const configuredBy = '22222222-2222-4222-8222-222222222222';

describe('payment policy configuration', () => {
  it('accepts a fully-specified configuration', () => {
    const input = {
      clientId,
      holdThenApprove: true,
      shortPayEnabled: false,
      approvalExpiryHours: 72,
      configuredBy,
    };
    expect(parsePaymentPolicyConfig(input)).toEqual(input);
  });

  it('defaults hold-then-approve to true and short-pay to false for a client with no explicit policy yet', () => {
    expect(DEFAULT_PAYMENT_POLICY).toEqual({
      holdThenApprove: true,
      shortPayEnabled: false,
      approvalExpiryHours: 72,
    });
  });

  it.each([
    ['missing holdThenApprove (never implicitly defaulted off)', { clientId, shortPayEnabled: false, approvalExpiryHours: 72, configuredBy }],
    ['negative approvalExpiryHours', { clientId, holdThenApprove: true, shortPayEnabled: false, approvalExpiryHours: -1, configuredBy }],
    ['zero approvalExpiryHours', { clientId, holdThenApprove: true, shortPayEnabled: false, approvalExpiryHours: 0, configuredBy }],
    ['approvalExpiryHours over the 30-day cap', { clientId, holdThenApprove: true, shortPayEnabled: false, approvalExpiryHours: 24 * 31, configuredBy }],
    ['non-integer approvalExpiryHours', { clientId, holdThenApprove: true, shortPayEnabled: false, approvalExpiryHours: 1.5, configuredBy }],
    ['invalid clientId', { clientId: 'not-a-uuid', holdThenApprove: true, shortPayEnabled: false, approvalExpiryHours: 72, configuredBy }],
    ['unknown field', { clientId, holdThenApprove: true, shortPayEnabled: false, approvalExpiryHours: 72, configuredBy, extra: 'nope' }],
  ])('fails closed for %s', (_label, payload) => {
    expect(() => parsePaymentPolicyConfig(payload)).toThrow(PaymentPolicyValidationError);
  });

  it('returns stable, sanitized validation details', () => {
    try {
      parsePaymentPolicyConfig({ clientId: 'nope', holdThenApprove: true, shortPayEnabled: false, approvalExpiryHours: 72, configuredBy });
      expect.fail('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(PaymentPolicyValidationError);
      expect(error).toMatchObject({ code: 'PAYMENT_POLICY_INVALID' });
      expect((error as PaymentPolicyValidationError).issues).toEqual([{ path: 'clientId', code: 'invalid_format' }]);
    }
  });
});
