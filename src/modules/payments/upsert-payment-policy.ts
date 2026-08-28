import type pg from 'pg';
import { parsePaymentPolicyConfig, type PaymentPolicyConfig } from './payment-policy-config.js';

/**
 * Configuration-only write boundary (P4.B.1). Upserts one row per client;
 * never reads or acts on the policy against a payment. Call inside a
 * tenant-scoped transaction (withTenantTx) so RLS restricts client_id to
 * the caller's own tenants.
 */
export async function upsertPaymentPolicy(
  client: pg.PoolClient,
  untrusted: unknown,
): Promise<PaymentPolicyConfig> {
  const input = parsePaymentPolicyConfig(untrusted);
  await client.query(
    `INSERT INTO client_payment_policy
       (client_id, hold_then_approve, short_pay_enabled, approval_expiry_hours, configured_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (client_id) DO UPDATE SET
       hold_then_approve = EXCLUDED.hold_then_approve,
       short_pay_enabled = EXCLUDED.short_pay_enabled,
       approval_expiry_hours = EXCLUDED.approval_expiry_hours,
       updated_at = now()`,
    [input.clientId, input.holdThenApprove, input.shortPayEnabled, input.approvalExpiryHours, input.configuredBy],
  );
  return input;
}
