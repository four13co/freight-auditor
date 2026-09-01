import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { listClientInvoices } from '../../src/modules/portal/list-client-invoices.js';

const CLIENT_ID = '40000000-0000-4000-8000-000000000001';

function mockClient(rows: unknown[] = []) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('listClientInvoices', () => {
  it('returns an empty array when the tenant has no invoices', async () => {
    const { client } = mockClient([]);
    const result = await listClientInvoices(client, CLIENT_ID);
    expect(result).toEqual([]);
  });

  it('maps a row to the camelCase shape, including the joined carrier name', async () => {
    const { client } = mockClient([
      {
        id: 'inv-1', invoice_number: 'INV-100', carrier_id: 'car-1', carrier_name: 'Acme Freight',
        currency: 'USD', status: 'ingested', created_at: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    const result = await listClientInvoices(client, CLIENT_ID);
    expect(result).toEqual([
      {
        id: 'inv-1', invoiceNumber: 'INV-100', carrierId: 'car-1', carrierName: 'Acme Freight',
        currency: 'USD', status: 'ingested', createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
  });

  it('scopes the query to the given clientId as the first parameter', async () => {
    const { client, query } = mockClient([]);
    await listClientInvoices(client, CLIENT_ID);
    expect(query.mock.calls[0]![1]![0]).toBe(CLIENT_ID);
  });

  it('adds a status predicate and parameter when status is provided', async () => {
    const { client, query } = mockClient([]);
    await listClientInvoices(client, CLIENT_ID, { status: 'ingested' });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('i.status = $2');
    expect(params).toContain('ingested');
  });

  it('defaults limit to 50 and offset to 0 when not provided', async () => {
    const { client, query } = mockClient([]);
    await listClientInvoices(client, CLIENT_ID);
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params.slice(-2)).toEqual([50, 0]);
  });

  it('threads a provided limit and offset through as query parameters', async () => {
    const { client, query } = mockClient([]);
    await listClientInvoices(client, CLIENT_ID, { limit: 10, offset: 20 });
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params.slice(-2)).toEqual([10, 20]);
  });

  it('orders by created_at DESC', async () => {
    const { client, query } = mockClient([]);
    await listClientInvoices(client, CLIENT_ID);
    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ORDER BY i.created_at DESC');
  });
});
