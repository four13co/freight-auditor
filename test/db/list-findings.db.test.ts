import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { listFindings } from '../../src/modules/findings/list-findings.js';

/**
 * 86e2u7j0d: GET /api/findings' backing query. Covers the join path
 * (variance_finding -> charge_fact -> invoice -> carrier, + expected_charge),
 * RLS tenant isolation, and status/carrier filters.
 */
describe('listFindings (DB)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let clientBId: string;
  let carrierId: string;
  const tag = `lf-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('LF-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const b = await owner.query(`INSERT INTO client (name, slug) VALUES ('LF-B', $1) RETURNING id`, [`${tag}-b`]);
      clientBId = b.rows[0].id;
      const carrier = await owner.query(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [`Carrier-${tag}`]);
      carrierId = carrier.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM variance_finding WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM expected_charge WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM charge_fact WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM audit_run WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM invoice WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM carrier WHERE id = $1`, [carrierId]);
      await owner.query(`DELETE FROM client WHERE id IN ($1, $2)`, [clientAId, clientBId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  /** Seeds one full variance_finding row (through charge_fact/invoice/audit_run) for a client. */
  async function seedFinding(
    client: pg.PoolClient,
    opts: {
      clientId: string;
      status?: string;
      direction?: string;
      billed?: string;
      expected?: string;
      variance?: string;
    },
  ): Promise<string> {
    const inv = await client.query(
      `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version)
       VALUES ($1, $2, '210', $3, 'USD', 'test') RETURNING id`,
      [opts.clientId, carrierId, `INV-${tag}-${Math.random().toString(36).slice(2)}`],
    );
    const invoiceId = inv.rows[0].id;

    const run = await client.query(
      `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome)
       VALUES ($1, $2, 'test', 'SCORED') RETURNING id`,
      [opts.clientId, invoiceId],
    );
    const auditRunId = run.rows[0].id;

    const cf = await client.query(
      `INSERT INTO charge_fact (client_id, invoice_id, code, category, amount, currency)
       VALUES ($1, $2, '400', 'LINEHAUL', $3, 'USD') RETURNING id`,
      [opts.clientId, invoiceId, opts.billed ?? '1000.0000'],
    );
    const chargeFactId = cf.rows[0].id;

    await client.query(
      `INSERT INTO expected_charge (client_id, audit_run_id, charge_fact_id, category, expected_amount, currency)
       VALUES ($1, $2, $3, 'LINEHAUL', $4, 'USD')`,
      [opts.clientId, auditRunId, chargeFactId, opts.expected ?? '900.0000'],
    );

    const vf = await client.query(
      `INSERT INTO variance_finding
         (client_id, audit_run_id, charge_fact_id, direction, variance_amount, currency, status)
       VALUES ($1, $2, $3, $4, $5, 'USD', $6) RETURNING id`,
      [
        opts.clientId,
        auditRunId,
        chargeFactId,
        opts.direction ?? 'OVERCHARGE',
        opts.variance ?? '100.0000',
        opts.status ?? 'open',
      ],
    );
    return vf.rows[0].id;
  }

  it('AC1: returns seeded rows with invoice/carrier/billed/expected/variance/status', async () => {
    const rows = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      await seedFinding(c, { clientId: clientAId });
      return listFindings(c, { clientIds: [clientAId] });
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      carrierName: `Carrier-${tag}`,
      billed: '1000.0000',
      expected: '900.0000',
      varianceAmount: '100.0000',
      direction: 'OVERCHARGE',
      status: 'open',
    });
    expect(typeof rows[0].invoiceNumber).toBe('string');
    expect(typeof rows[0].createdAt).toBe('object'); // Date, via pg
  });

  it('AC2: client B never sees client A rows (RLS isolation)', async () => {
    await withTenantTx({ clientIds: [clientAId], internal: true }, (c) => seedFinding(c, { clientId: clientAId }));
    const bRows = await withTenantTx({ clientIds: [clientBId], internal: true }, async (c) => {
      return listFindings(c, { clientIds: [clientBId] });
    });
    expect(bRows).toHaveLength(0);
  });

  it('AC3: status filter narrows the result set', async () => {
    const rows = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      await seedFinding(c, { clientId: clientAId, status: 'open' });
      await seedFinding(c, { clientId: clientAId, status: 'closed' });
      return listFindings(c, { clientIds: [clientAId], status: 'closed' });
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.status === 'closed')).toBe(true);
  });

  it('AC3: carrier filter narrows the result set to that carrier only', async () => {
    const otherCarrier = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const oc = await c.query(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [`Other-${tag}`]);
      return oc.rows[0].id as string;
    });
    try {
      const rows = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
        await seedFinding(c, { clientId: clientAId });
        // seed a second finding under the other carrier by inserting invoice directly
        const inv = await c.query(
          `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version)
           VALUES ($1, $2, '210', $3, 'USD', 'test') RETURNING id`,
          [clientAId, otherCarrier, `INV-${tag}-other`],
        );
        const run = await c.query(
          `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'test', 'SCORED') RETURNING id`,
          [clientAId, inv.rows[0].id],
        );
        const cf = await c.query(
          `INSERT INTO charge_fact (client_id, invoice_id, code, category, amount, currency) VALUES ($1, $2, '400', 'LINEHAUL', '500.0000', 'USD') RETURNING id`,
          [clientAId, inv.rows[0].id],
        );
        await c.query(
          `INSERT INTO variance_finding (client_id, audit_run_id, charge_fact_id, direction, variance_amount, currency, status)
           VALUES ($1, $2, $3, 'OVERCHARGE', '50.0000', 'USD', 'open')`,
          [clientAId, run.rows[0].id, cf.rows[0].id],
        );
        return listFindings(c, { clientIds: [clientAId], carrier: `Other-${tag}` });
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].carrierName).toBe(`Other-${tag}`);
    } finally {
      await withTenantTx({ clientIds: [clientAId], internal: true }, (c) =>
        c.query(`DELETE FROM carrier WHERE id = $1`, [otherCarrier]),
      );
    }
  });
});
