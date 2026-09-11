import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { listInvoices } from '../../src/modules/invoices/list-invoices.js';

/**
 * 86e37r2rt: GET /api/invoices' backing query. Covers the join path
 * (invoice -> carrier, + summed charge_fact), RLS tenant isolation, and
 * carrier/status filters -- same shape as list-findings.db.test.ts.
 */
describe('listInvoices (DB)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let clientBId: string;
  let carrierId: string;
  const tag = `li-${Date.now()}`;
  const extraCarrierIds: string[] = [];

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('LI-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const b = await owner.query(`INSERT INTO client (name, slug) VALUES ('LI-B', $1) RETURNING id`, [`${tag}-b`]);
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
      await owner.query(`DELETE FROM charge_fact WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM invoice WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM carrier WHERE id = ANY($1::uuid[])`, [[carrierId, ...extraCarrierIds]]);
      await owner.query(`DELETE FROM client WHERE id IN ($1, $2)`, [clientAId, clientBId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  async function seedInvoice(
    client: pg.PoolClient,
    opts: { clientId: string; invoiceNumber?: string; carrierId?: string; status?: string; charges?: string[] },
  ): Promise<{ id: string }> {
    const inv = await client.query(
      `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version, status)
       VALUES ($1, $2, '210', $3, 'USD', 'test', $4) RETURNING id`,
      [
        opts.clientId,
        opts.carrierId ?? carrierId,
        opts.invoiceNumber ?? `INV-${tag}-${Math.random().toString(36).slice(2)}`,
        opts.status ?? 'ingested',
      ],
    );
    const invoiceId = inv.rows[0].id;

    for (const amount of opts.charges ?? []) {
      await client.query(
        `INSERT INTO charge_fact (client_id, invoice_id, code, category, amount, currency)
         VALUES ($1, $2, '400', 'LINEHAUL', $3, 'USD')`,
        [opts.clientId, invoiceId, amount],
      );
    }
    return { id: invoiceId };
  }

  it('AC1: returns seeded rows with carrier + correctly summed billedTotal', async () => {
    const rows = await withTenantTx({ clientIds: [clientAId], internal: false }, async (c) => {
      await seedInvoice(c, { clientId: clientAId, invoiceNumber: `INV-${tag}-ac1`, charges: ['100.0000', '25.5000'] });
      return listInvoices(c, {});
    });
    const matching = rows.find((r) => r.invoiceNumber === `INV-${tag}-ac1`);
    expect(matching).toBeDefined();
    expect(matching?.carrierName).toBe(`Carrier-${tag}`);
    expect(matching?.billedTotal).toBe('125.5000');
    expect(matching?.transactionSet).toBe('210');
    expect(matching?.status).toBe('ingested');
  });

  it('an invoice with no charge_fact rows surfaces with billedTotal null, not zero', async () => {
    const rows = await withTenantTx({ clientIds: [clientAId], internal: false }, async (c) => {
      await seedInvoice(c, { clientId: clientAId, invoiceNumber: `INV-${tag}-no-charges` });
      return listInvoices(c, {});
    });
    const matching = rows.find((r) => r.invoiceNumber === `INV-${tag}-no-charges`);
    expect(matching).toBeDefined();
    expect(matching?.billedTotal).toBeNull();
  });

  it('AC2/RLS: client B never sees client A invoices', async () => {
    await withTenantTx({ clientIds: [clientAId], internal: true }, (c) =>
      seedInvoice(c, { clientId: clientAId, invoiceNumber: `INV-${tag}-rls` }));
    const bRows = await withTenantTx({ clientIds: [clientBId], internal: false }, (c) => listInvoices(c, {}));
    expect(bRows.find((r) => r.invoiceNumber === `INV-${tag}-rls`)).toBeUndefined();
  });

  it('AC3: carrier filter narrows the result set to that carrier only', async () => {
    const otherCarrier = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const oc = await c.query(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [`Other-${tag}`]);
      return oc.rows[0].id as string;
    });
    extraCarrierIds.push(otherCarrier);

    const rows = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      await seedInvoice(c, { clientId: clientAId, invoiceNumber: `INV-${tag}-carrierA` });
      await seedInvoice(c, { clientId: clientAId, invoiceNumber: `INV-${tag}-carrierOther`, carrierId: otherCarrier });
      return listInvoices(c, { carrier: `Other-${tag}` });
    });
    expect(rows.map((r) => r.invoiceNumber)).toContain(`INV-${tag}-carrierOther`);
    expect(rows.map((r) => r.invoiceNumber)).not.toContain(`INV-${tag}-carrierA`);
  });

  it('AC3: status filter narrows the result set to that status only', async () => {
    const rows = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      await seedInvoice(c, { clientId: clientAId, invoiceNumber: `INV-${tag}-ingested`, status: 'ingested' });
      await seedInvoice(c, { clientId: clientAId, invoiceNumber: `INV-${tag}-other-status`, status: 'reviewed' });
      return listInvoices(c, { status: 'reviewed' });
    });
    expect(rows.map((r) => r.invoiceNumber)).toContain(`INV-${tag}-other-status`);
    expect(rows.map((r) => r.invoiceNumber)).not.toContain(`INV-${tag}-ingested`);
  });

  it('paginates via limit/offset', async () => {
    const rows = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      await seedInvoice(c, { clientId: clientAId, invoiceNumber: `INV-${tag}-page-1` });
      await seedInvoice(c, { clientId: clientAId, invoiceNumber: `INV-${tag}-page-2` });
      return listInvoices(c, { carrier: `Carrier-${tag}`, limit: 1, offset: 0 });
    });
    expect(rows).toHaveLength(1);
  });
});
