import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { getPortfolioReconciliation } from '../../src/modules/claims/get-portfolio-reconciliation.js';

const CLIENT_ID = '50000000-0000-4000-8000-000000000001';
const CLAIM_ID = '50000000-0000-4000-8000-000000000002';

function mockClient(opts: { claims?: unknown[]; events?: unknown[] } = {}) {
  const { claims = [], events = [] } = opts;
  const query = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('FROM claim')) return Promise.resolve({ rows: claims });
    if (sql.includes('FROM recovery_event')) return Promise.resolve({ rows: events });
    throw new Error(`unexpected query: ${sql}`);
  });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('getPortfolioReconciliation', () => {
  it('returns an empty array when the tenant has no claims, without querying recovery_event', async () => {
    const { client, query } = mockClient({ claims: [] });
    const result = await getPortfolioReconciliation(client, { clientId: CLIENT_ID });
    expect(result).toEqual([]);
    expect(query.mock.calls.some((c: unknown[]) => (c[0] as string).includes('FROM recovery_event'))).toBe(false);
  });

  it('aggregates one claim with no recovery events into a single outstanding bucket', async () => {
    const { client } = mockClient({
      claims: [{ claim_id: CLAIM_ID, amount_claimed: '500.0000', currency: 'USD', status: 'open' }],
      events: [],
    });
    const result = await getPortfolioReconciliation(client, { clientId: CLIENT_ID });
    expect(result).toEqual([
      {
        currency: 'USD', claimed: '500.0000', recovered: '0.0000', outstanding: '500.0000',
        writtenOff: '0.0000', denied: '0.0000', nullCurrencyRecovered: '0.0000',
        mismatchedCurrencyRecovered: '0.0000', reconciles: true,
      },
    ]);
  });

  it('scopes the claim query to the given clientId with no carrier join', async () => {
    const { client, query } = mockClient({ claims: [] });
    await getPortfolioReconciliation(client, { clientId: CLIENT_ID });
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain('dispute');
    expect(sql).not.toContain('carrier');
    expect(values).toEqual([CLIENT_ID]);
  });

  it('rejects a malformed clientId', async () => {
    const { client } = mockClient();
    await expect(getPortfolioReconciliation(client, { clientId: 'not-a-uuid' })).rejects.toThrow();
  });
});
