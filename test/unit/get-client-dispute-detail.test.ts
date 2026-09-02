import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { getClientDisputeDetail } from '../../src/modules/portal/get-client-dispute-detail.js';

/**
 * Unit-level coverage of getClientDisputeDetail's query-building, mirroring
 * get-dispute-detail.test.ts's structure exactly -- the added coverage here
 * is the explicit `client_id` predicate (86e31a9ch/#216 precedent) that
 * get-dispute-detail.ts deliberately does NOT have (RLS-only).
 */
const DISPUTE_ID = '70000000-0000-4000-8000-000000000001';
const CLIENT_ID = 'client-abc';
const CARRIER_ID = '70000000-0000-4000-8000-000000000002';
const LINE_ID = '70000000-0000-4000-8000-000000000003';
const CREATED_AT = new Date('2026-08-01T00:00:00.000Z');

function mockClient(opts: { disputeRows?: unknown[]; lineRows?: unknown[] }) {
  const { disputeRows = [], lineRows = [] } = opts;
  const query = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('FROM dispute WHERE id')) return Promise.resolve({ rows: disputeRows });
    if (sql.includes('FROM dispute_line')) return Promise.resolve({ rows: lineRows });
    throw new Error(`unexpected query: ${sql}`);
  });
  return { query } as unknown as pg.PoolClient;
}

describe('getClientDisputeDetail (unit, mocked client)', () => {
  it('returns null when the dispute does not exist / is not visible to this clientId', async () => {
    const client = mockClient({ disputeRows: [] });
    const result = await getClientDisputeDetail(client, CLIENT_ID, DISPUTE_ID);
    expect(result).toBeNull();
  });

  it('returns the dispute with its lines mapped to camelCase', async () => {
    const client = mockClient({
      disputeRows: [{ id: DISPUTE_ID, carrier_id: CARRIER_ID, status: 'draft', amount_claimed: '500.0000', currency: 'USD', created_at: CREATED_AT }],
      lineRows: [{ id: LINE_ID, variance_finding_id: null, amount: '500.0000', currency: 'USD' }],
    });
    const result = await getClientDisputeDetail(client, CLIENT_ID, DISPUTE_ID);
    expect(result).toEqual({
      id: DISPUTE_ID, carrierId: CARRIER_ID, status: 'draft', amountClaimed: '500.0000', currency: 'USD',
      createdAt: CREATED_AT,
      lines: [{ id: LINE_ID, varianceFindingId: null, amount: '500.0000', currency: 'USD' }],
    });
  });

  it('returns an empty lines array for a dispute with no lines yet', async () => {
    const client = mockClient({
      disputeRows: [{ id: DISPUTE_ID, carrier_id: CARRIER_ID, status: 'draft', amount_claimed: null, currency: null, created_at: CREATED_AT }],
      lineRows: [],
    });
    const result = await getClientDisputeDetail(client, CLIENT_ID, DISPUTE_ID);
    expect(result?.lines).toEqual([]);
  });

  it('binds disputeId and clientId as the dispute query params, in that order', async () => {
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('FROM dispute WHERE id')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    const client = { query } as unknown as pg.PoolClient;
    await getClientDisputeDetail(client, CLIENT_ID, DISPUTE_ID);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/WHERE id = \$1 AND client_id = \$2/);
    expect(params).toEqual([DISPUTE_ID, CLIENT_ID]);
  });

  it('binds disputeId and clientId as the dispute_line query params, in that order', async () => {
    const client = mockClient({
      disputeRows: [{ id: DISPUTE_ID, carrier_id: CARRIER_ID, status: 'draft', amount_claimed: null, currency: null, created_at: CREATED_AT }],
      lineRows: [],
    });
    await getClientDisputeDetail(client, CLIENT_ID, DISPUTE_ID);
    const lineCall = (client.query as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[0] as string).includes('FROM dispute_line'),
    ) as [string, unknown[]];
    expect(lineCall[0]).toMatch(/WHERE dispute_id = \$1 AND client_id = \$2/);
    expect(lineCall[1]).toEqual([DISPUTE_ID, CLIENT_ID]);
  });
});
