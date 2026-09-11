import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { listInvoices } from '../../src/modules/invoices/list-invoices.js';

/**
 * Unit-level coverage of listInvoices' query-building (WHERE clause, param
 * order, GROUP BY, LIMIT/OFFSET, row mapping) via a mocked pg client -- no
 * live DB. test/db/list-invoices.db.test.ts covers the same function against
 * real Postgres (RLS, the billed-total sum, filters) and stays the source of
 * truth for that behavior; this file exists so the default coverage gate
 * (test/db/** excluded) also exercises this module. Mirrors
 * test/unit/list-findings.test.ts's own structure.
 */
function mockRow() {
  return {
    id: 'inv-1',
    invoice_number: 'INV-1',
    carrier_name: 'ACME',
    transaction_set: '210',
    status: 'ingested',
    currency: 'USD',
    created_at: new Date('2026-01-01T00:00:00Z'),
    billed_total: '1500.0000',
  };
}

function mockClient(rows: ReturnType<typeof mockRow>[]) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('listInvoices (unit, mocked client)', () => {
  it('maps a returned row from snake_case columns to the InvoiceRow shape', async () => {
    const { client } = mockClient([mockRow()]);
    const rows = await listInvoices(client, {});
    expect(rows).toEqual([
      {
        id: 'inv-1',
        invoiceNumber: 'INV-1',
        carrierName: 'ACME',
        transactionSet: '210',
        status: 'ingested',
        currency: 'USD',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        billedTotal: '1500.0000',
      },
    ]);
  });

  it('builds no WHERE clause and uses default LIMIT/OFFSET when no filters are given', async () => {
    const { client, query } = mockClient([]);
    await listInvoices(client, {});
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toMatch(/WHERE/);
    expect(params).toEqual([50, 0]);
  });

  it('adds a carrier condition and binds it positionally', async () => {
    const { client, query } = mockClient([]);
    await listInvoices(client, { carrier: 'ACME' });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/carrier\.name = \$1/);
    expect(params).toEqual(['ACME', 50, 0]);
  });

  it('adds a status condition and binds it positionally', async () => {
    const { client, query } = mockClient([]);
    await listInvoices(client, { status: 'ingested' });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/invoice\.status = \$1/);
    expect(params).toEqual(['ingested', 50, 0]);
  });

  it('combines carrier and status filters with AND, each at its own param index', async () => {
    const { client, query } = mockClient([]);
    await listInvoices(client, { carrier: 'ACME', status: 'ingested' });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/carrier\.name = \$1 AND invoice\.status = \$2/);
    expect(params).toEqual(['ACME', 'ingested', 50, 0]);
  });

  it('honors explicit limit and offset', async () => {
    const { client, query } = mockClient([]);
    await listInvoices(client, { limit: 10, offset: 20 });
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([10, 20]);
  });

  it('groups by invoice.id and carrier.name so the billed-total SUM aggregates per invoice', async () => {
    const { client, query } = mockClient([]);
    await listInvoices(client, {});
    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/GROUP BY invoice\.id, carrier\.name/);
  });

  it('orders by created_at DESC', async () => {
    const { client, query } = mockClient([]);
    await listInvoices(client, {});
    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ORDER BY invoice\.created_at DESC/);
  });

  it('returns an empty array when the query has no matching rows', async () => {
    const { client } = mockClient([]);
    const rows = await listInvoices(client, {});
    expect(rows).toEqual([]);
  });
});
