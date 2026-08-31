import { z } from 'zod';

/**
 * Per-client payment-policy configuration (P4.B.1). This module validates
 * and shapes the CONFIGURATION only -- it never decides a payment. Reading
 * or enforcing this policy against an actual invoice/dispute is out of
 * scope here: hold-then-approve enforcement (P4.B.2), short-pay behavior
 * (P4.B.3), do-not-pay decisions (P4.B.4), and expired-approval escalation
 * (P4.B.7) each own their own boundary.
 *
 * hold_then_approve defaults to true (the platform default, §10) and this
 * schema cannot express turning it off implicitly -- an update must name
 * the value explicitly, so a client is never silently moved off the
 * hold-then-approve default by a partial payload.
 */
export const PaymentPolicyConfigSchema = z.object({
  clientId: z.uuid(),
  holdThenApprove: z.boolean(),
  shortPayEnabled: z.boolean(),
  approvalExpiryHours: z.number().int().positive().max(24 * 30),
  configuredBy: z.uuid(),
}).strict();

export type PaymentPolicyConfig = z.infer<typeof PaymentPolicyConfigSchema>;

/** The configuration a client has before anyone has explicitly set one. */
export const DEFAULT_PAYMENT_POLICY: Omit<PaymentPolicyConfig, 'clientId' | 'configuredBy'> = {
  holdThenApprove: true,
  shortPayEnabled: false,
  approvalExpiryHours: 72,
};

export class PaymentPolicyValidationError extends Error {
  readonly code = 'PAYMENT_POLICY_INVALID';
  constructor(readonly issues: ReadonlyArray<{ path: string; code: string }>) {
    super('Invalid payment policy configuration');
    this.name = 'PaymentPolicyValidationError';
  }
}

/** Validate untrusted configuration input before it reaches a write. */
export function parsePaymentPolicyConfig(untrusted: unknown): PaymentPolicyConfig {
  const result = PaymentPolicyConfigSchema.safeParse(untrusted);
  if (!result.success) {
    throw new PaymentPolicyValidationError(
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
    );
  }
  return result.data;
}
