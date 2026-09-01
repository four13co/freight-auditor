import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { getClientScorecardSummary } from '../../src/modules/portal/get-client-scorecard-summary.js';

const CLIENT_ID = '40000000-0000-4000-8000-000000000001';

function mockClient(rows: unknown[] = []) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('getClientScorecardSummary', () => {
  it('returns an empty array when the tenant has no scorecard rows', async () => {
    const { client } = mockClient([]);
    const result = await getClientScorecardSummary(client, CLIENT_ID);
    expect(result).toEqual([]);
  });

  it('maps a per-currency row to the camelCase bucket shape', async () => {
    const { client } = mockClient([
      {
        currency: 'USD', run_count: '3', conformed_count: '10', variance_count: '4',
        unassessable_count: '1', total_overcharge: '1500.0000', total_undercharge: '20.0000',
      },
    ]);
    const result = await getClientScorecardSummary(client, CLIENT_ID);
    expect(result).toEqual([
      {
        currency: 'USD', runCount: 3, conformedCount: 10, varianceCount: 4,
        unassessableCount: 1, totalOvercharge: '1500.0000', totalUndercharge: '20.0000',
      },
    ]);
  });

  it('keeps separate buckets per currency rather than blending totals', async () => {
    const { client } = mockClient([
      { currency: 'USD', run_count: '1', conformed_count: '5', variance_count: '0', unassessable_count: '0', total_overcharge: '0', total_undercharge: '0' },
      { currency: 'CAD', run_count: '1', conformed_count: '2', variance_count: '1', unassessable_count: '0', total_overcharge: '0', total_undercharge: '0' },
    ]);
    const result = await getClientScorecardSummary(client, CLIENT_ID);
    expect(result).toHaveLength(2);
    expect(result.map((b) => b.currency)).toEqual(['USD', 'CAD']);
  });

  it('scopes the query to the given clientId as the sole parameter', async () => {
    const { client, query } = mockClient([]);
    await getClientScorecardSummary(client, CLIENT_ID);
    expect(query.mock.calls[0]![1]).toEqual([CLIENT_ID]);
  });

  it('groups by currency', async () => {
    const { client, query } = mockClient([]);
    await getClientScorecardSummary(client, CLIENT_ID);
    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('GROUP BY currency');
  });
});
