import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { listInvoices } from '../../src/modules/invoices/list-invoices.js';

/**
 * 86e37r2rt: GET /api/invoices' backing query. Covers the join path
 * (invoice -> carrier, invoice -> charge_fact summed), carrier/status
 * filters, and cross-client visibility under an internal-analyst scope
 * (mirrors get-cross-client-portfolio.db.test.ts's approach -- this route is
 * internal-analyst-only and cross-client BY DESIGN, so assertions key off a
 * known invoiceNumber rather than an exact row count, the same way that
 * suite's own header comment reasons about pollution from other clients'
 * pre-existing data).
 */
describe('listInvoices (DB)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let carrierId: string;
  const tag = `li-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('LI-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const carrier = await owner.query(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [`Carrier-${tag}`]);
      carrierId = carrier.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM charge_fact WHERE client_id = $1`, [clientAId]);
      await owner.query(`DELETE FROM invoice WHERE client_id = $1`, [clientAId]);
      await owner.query(`DELETE FROM carrier WHERE id = $1`, [carrierId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientAId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  async function seedInvoice(
    client: pg.PoolClient,
    opts: { invoiceNumber: string; status?: string; charges?: string[] },
  ): Promise<string> {
    const inv = await client.query(
      `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version, status)
       VALUES ($1, $2, '210', $3, 'USD', 'test', $4) RETURNING id`,
      [clientAId, carrierId, opts.invoiceNumber, opts.status ?? 'ingested'],
    );
    const invoiceId = inv.rows[0].id;
    for (const amount of opts.charges ?? []) {
      await client.query(
        `INSERT INTO charge_fact (client_id, invoice_id, code, category, amount, currency)
         VALUES ($1, $2, '400', 'LINEHAUL', $3, 'USD')`,
        [clientAId, invoiceId, amount],
      );
    }
    return invoiceId;
  }

  it('AC1: returns an invoice with a correctly summed billedTotal across its charges', async () => {
    const invoiceNumber = `INV-${tag}-billed`;
    const rows = await withTenantTx({ internal: true }, async (c) => {
      await seedInvoice(c, { invoiceNumber, charges: ['400.0000', '150.5000'] });
      return listInvoices(c, { carrier: `Carrier-${tag}` });
    });
    const match = rows.find((r) => r.invoiceNumber === invoiceNumber);
    expect(match).toMatchObject({ carrierName: `Carrier-${tag}`, billedTotal: '550.5000', status: 'ingested' });
  });

  it('AC1: an invoice with no charges yet gets billedTotal "0.0000", not null', async () => {
    const invoiceNumber = `INV-${tag}-no-charges`;
    const rows = await withTenantTx({ internal: true }, async (c) => {
      await seedInvoice(c, { invoiceNumber });
      return listInvoices(c, { carrier: `Carrier-${tag}` });
    });
    const match = rows.find((r) => r.invoiceNumber === invoiceNumber);
    expect(match?.billedTotal).toBe('0.0000');
  });

  it('AC2: a carrier or status query param narrows the result set to matching rows only', async () => {
    const otherCarrierName = `Other-${tag}`;
    const rows = await withTenantTx({ internal: true }, async (c) => {
      const other = await c.query(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [otherCarrierName]);
      const otherCarrierId = other.rows[0].id as string;
      await c.query(
        `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version, status)
         VALUES ($1, $2, '210', $3, 'USD', 'test', 'ingested')`,
        [clientAId, otherCarrierId, `INV-${tag}-other-carrier`],
      );
      await seedInvoice(c, { invoiceNumber: `INV-${tag}-status-a`, status: 'ingested' });
      await seedInvoice(c, { invoiceNumber: `INV-${tag}-status-b`, status: 'reconciled' });

      const byCarrier = await listInvoices(c, { carrier: otherCarrierName });
      const byStatus = await listInvoices(c, { carrier: `Carrier-${tag}`, status: 'reconciled' });
      return { byCarrier, byStatus };
    });

    expect(rows.byCarrier.every((r) => r.carrierName === otherCarrierName)).toBe(true);
    expect(rows.byCarrier.some((r) => r.invoiceNumber === `INV-${tag}-other-carrier`)).toBe(true);

    expect(rows.byStatus.every((r) => r.status === 'reconciled')).toBe(true);
    expect(rows.byStatus.some((r) => r.invoiceNumber === `INV-${tag}-status-b`)).toBe(true);
    expect(rows.byStatus.some((r) => r.invoiceNumber === `INV-${tag}-status-a`)).toBe(false);
  });

  it('CRITICAL: a non-internal, single-client transaction sees only its own client, never another client\'s invoice', async () => {
    const invoiceNumber = `INV-${tag}-isolation`;
    await withTenantTx({ clientIds: [clientAId], internal: false }, (c) => seedInvoice(c, { invoiceNumber }));

    const otherClient = await pool.connect();
    let otherClientId = '';
    try {
      const oc = await otherClient.query(`INSERT INTO client (name, slug) VALUES ('LI-B', $1) RETURNING id`, [`${tag}-b`]);
      otherClientId = oc.rows[0].id;
    } finally {
      otherClient.release();
    }

    const bRows = await withTenantTx({ clientIds: [otherClientId], internal: false }, (c) => listInvoices(c, {}));
    expect(bRows.find((r) => r.invoiceNumber === invoiceNumber)).toBeUndefined();

    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM client WHERE id = $1`, [otherClientId]);
    } finally {
      owner.release();
    }
  });
});
