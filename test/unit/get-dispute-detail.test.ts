import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { getDisputeDetail } from '../../src/modules/disputes/get-dispute-detail.js';

const DISPUTE_ID = '70000000-0000-4000-8000-000000000001';
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

describe('getDisputeDetail', () => {
  it('returns null when the dispute does not exist / is not visible under RLS', async () => {
    const client = mockClient({ disputeRows: [] });
    const result = await getDisputeDetail(client, DISPUTE_ID);
    expect(result).toBeNull();
  });

  it('returns the dispute with its lines mapped to camelCase', async () => {
    const client = mockClient({
      disputeRows: [{ id: DISPUTE_ID, carrier_id: CARRIER_ID, status: 'draft', amount_claimed: '500.0000', currency: 'USD', created_at: CREATED_AT }],
      lineRows: [{ id: LINE_ID, variance_finding_id: null, amount: '500.0000', currency: 'USD' }],
    });
    const result = await getDisputeDetail(client, DISPUTE_ID);
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
    const result = await getDisputeDetail(client, DISPUTE_ID);
    expect(result?.lines).toEqual([]);
  });
});
