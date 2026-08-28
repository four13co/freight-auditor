import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { detectUnknownChargeCodeTriggers } from '../../src/modules/discovery/detect-unknown-charge-code-triggers.js';

/**
 * P3.D.2: an unknown/unresolved charge code (charge_fact.category IS NULL --
 * the persisted crosswalk-resolution-failure signal) surfaces as a discovery
 * trigger, scoped to the audit run's invoice, idempotent on re-run.
 */
describe('detectUnknownChargeCodeTriggers (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  let carrierId: string;
  const tag = `ucct-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('UCCT', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const carrier = await owner.query(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [`Carrier-${tag}`]);
      carrierId = carrier.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM unknown_charge_code_trigger WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM charge_fact WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM audit_run WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM invoice WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM carrier WHERE id = $1`, [carrierId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  async function seedInvoiceWithCharges(
    client: pg.PoolClient,
    charges: Array<{ code: string; category: string | null }>,
  ): Promise<{ auditRunId: string }> {
    const inv = await client.query(
      `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version)
       VALUES ($1, $2, '210', $3, 'USD', 'test') RETURNING id`,
      [clientId, carrierId, `INV-${tag}-${Math.random().toString(36).slice(2)}`],
    );
    const invoiceId = inv.rows[0].id;

    const run = await client.query(
      `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome)
       VALUES ($1, $2, 'test', 'SCORED') RETURNING id`,
      [clientId, invoiceId],
    );
    const auditRunId = run.rows[0].id;

    for (const charge of charges) {
      await client.query(
        `INSERT INTO charge_fact (client_id, invoice_id, code, category, amount, currency)
         VALUES ($1, $2, $3, $4, '100.0000', 'USD')`,
        [clientId, invoiceId, charge.code, charge.category],
      );
    }
    return { auditRunId };
  }

  it('creates a trigger for each uncategorized charge_fact row and is idempotent on re-run', async () => {
    const owner = await pool.connect();
    try {
      const { auditRunId } = await seedInvoiceWithCharges(owner, [
        { code: 'ZZZ', category: null },
        { code: '400', category: 'LINEHAUL' },
      ]);

      const first = await detectUnknownChargeCodeTriggers(owner, { clientId, auditRunId });
      expect(first.createdCount).toBe(1);
      expect(first.triggerIds).toHaveLength(1);

      const second = await detectUnknownChargeCodeTriggers(owner, { clientId, auditRunId });
      expect(second.createdCount).toBe(0);
      expect(second.triggerIds).toEqual(first.triggerIds);

      const rows = await owner.query(
        `SELECT source_code FROM unknown_charge_code_trigger WHERE client_id = $1 AND audit_run_id = $2`,
        [clientId, auditRunId],
      );
      expect(rows.rows).toEqual([{ source_code: 'ZZZ' }]);
    } finally {
      owner.release();
    }
  });

  it('creates no triggers when every charge on the invoice is categorized', async () => {
    const owner = await pool.connect();
    try {
      const { auditRunId } = await seedInvoiceWithCharges(owner, [{ code: '400', category: 'LINEHAUL' }]);
      const result = await detectUnknownChargeCodeTriggers(owner, { clientId, auditRunId });
      expect(result.createdCount).toBe(0);
      expect(result.triggerIds).toEqual([]);
    } finally {
      owner.release();
    }
  });

  it('throws AUDIT_RUN_NOT_FOUND for an audit run outside the tenant', async () => {
    const owner = await pool.connect();
    try {
      await expect(
        detectUnknownChargeCodeTriggers(owner, { clientId, auditRunId: '99999999-9999-4999-8999-999999999999' }),
      ).rejects.toMatchObject({ code: 'AUDIT_RUN_NOT_FOUND' });
    } finally {
      owner.release();
    }
  });
});
