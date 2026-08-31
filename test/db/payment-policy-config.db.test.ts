import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { upsertPaymentPolicy } from '../../src/modules/payments/upsert-payment-policy.js';
import { PaymentPolicyValidationError } from '../../src/modules/payments/payment-policy-config.js';

/**
 * P4.B.1: configuration-only write boundary. Proves the upsert is a real
 * per-client row (RLS-bound, one row per client) and that re-configuring
 * updates in place rather than accumulating history -- this table is current
 * state, not a ledger.
 */
describe('client payment policy configuration (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  let userId: string;
  const tag = `pp-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('PP', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const u = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}@example.com`]);
      userId = u.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM client_payment_policy WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM app_user WHERE id = $1`, [userId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('creates one row per client, defaulting to hold-then-approve when configured explicitly', async () => {
    const row = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      await upsertPaymentPolicy(c, {
        clientId, holdThenApprove: true, shortPayEnabled: false, approvalExpiryHours: 72, configuredBy: userId,
      });
      const result = await c.query(
        `SELECT hold_then_approve, short_pay_enabled, approval_expiry_hours FROM client_payment_policy WHERE client_id = $1`,
        [clientId],
      );
      return result.rows;
    });
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ hold_then_approve: true, short_pay_enabled: false, approval_expiry_hours: 72 });
  });

  it('re-configuring updates the existing row in place rather than inserting a second one', async () => {
    const rows = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      await upsertPaymentPolicy(c, {
        clientId, holdThenApprove: true, shortPayEnabled: true, approvalExpiryHours: 48, configuredBy: userId,
      });
      return (await c.query(
        `SELECT short_pay_enabled, approval_expiry_hours FROM client_payment_policy WHERE client_id = $1`,
        [clientId],
      )).rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ short_pay_enabled: true, approval_expiry_hours: 48 });
  });

  it('rejects an attempt to turn off hold-then-approve implicitly by omitting the field', async () => {
    await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      await expect(
        upsertPaymentPolicy(c, { clientId, shortPayEnabled: false, approvalExpiryHours: 72, configuredBy: userId }),
      ).rejects.toBeInstanceOf(PaymentPolicyValidationError);
    });
  });
});
