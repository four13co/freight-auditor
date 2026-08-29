import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { getClientRecoverySummary } from '../../src/modules/claims/get-client-recovery-summary.js';

const CLIENT_ID = '60000000-0000-4000-8000-000000000001';

function mockClient(opts: { claims?: unknown[]; events?: unknown[] } = {}) {
  const { claims = [], events = [] } = opts;
  const query = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('FROM claim')) return Promise.resolve({ rows: claims });
    if (sql.includes('FROM recovery_event')) return Promise.resolve({ rows: events });
    throw new Error(`unexpected query: ${sql}`);
  });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('getClientRecoverySummary', () => {
  it('returns an empty array when the tenant has no claims, without querying recovery_event', async () => {
    const { client, query } = mockClient({ claims: [] });
    const result = await getClientRecoverySummary(client, CLIENT_ID);
    expect(result).toEqual([]);
    expect(query.mock.calls.some((c: unknown[]) => (c[0] as string).includes('FROM recovery_event'))).toBe(false);
  });

  it('an open claim with no recovery is entirely outstanding', async () => {
    const { client } = mockClient({
      claims: [{ claim_id: 'c1', amount_claimed: '500.0000', currency: 'USD', status: 'open' }],
    });
    const result = await getClientRecoverySummary(client, CLIENT_ID);
    expect(result).toEqual([
      { currency: 'USD', claimed: '500.0000', recovered: '0.0000', outstanding: '500.0000', writtenOff: '0.0000', denied: '0.0000', reconciles: true },
    ]);
  });

  it('a fully recovered claim has zero outstanding/writtenOff/denied', async () => {
    const { client } = mockClient({
      claims: [{ claim_id: 'c1', amount_claimed: '500.0000', currency: 'USD', status: 'recovered' }],
      events: [{ claim_id: 'c1', amount_recovered: '500.0000', currency: 'USD' }],
    });
    const result = await getClientRecoverySummary(client, CLIENT_ID);
    expect(result[0]).toMatchObject({ claimed: '500.0000', recovered: '500.0000', outstanding: '0.0000', writtenOff: '0.0000', denied: '0.0000', reconciles: true });
  });

  it('a denied claim books the full claimed amount as denied, not writtenOff', async () => {
    const { client } = mockClient({
      claims: [{ claim_id: 'c1', amount_claimed: '300.0000', currency: 'USD', status: 'denied' }],
    });
    const result = await getClientRecoverySummary(client, CLIENT_ID);
    expect(result[0]).toMatchObject({ claimed: '300.0000', denied: '300.0000', outstanding: '0.0000', writtenOff: '0.0000', reconciles: true });
  });

  it('a written-off claim with a prior partial recovery books only the remainder as writtenOff', async () => {
    const { client } = mockClient({
      claims: [{ claim_id: 'c1', amount_claimed: '500.0000', currency: 'USD', status: 'written_off' }],
      events: [{ claim_id: 'c1', amount_recovered: '200.0000', currency: 'USD' }],
    });
    const result = await getClientRecoverySummary(client, CLIENT_ID);
    expect(result[0]).toMatchObject({ claimed: '500.0000', recovered: '200.0000', outstanding: '0.0000', writtenOff: '300.0000', denied: '0.0000', reconciles: true });
  });

  it('groups by currency separately, never summing across currencies', async () => {
    const { client } = mockClient({
      claims: [
        { claim_id: 'c1', amount_claimed: '500.0000', currency: 'USD', status: 'open' },
        { claim_id: 'c2', amount_claimed: '200.0000', currency: 'CAD', status: 'open' },
      ],
    });
    const result = await getClientRecoverySummary(client, CLIENT_ID);
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.currency === 'USD')).toMatchObject({ claimed: '500.0000' });
    expect(result.find((r) => r.currency === 'CAD')).toMatchObject({ claimed: '200.0000' });
  });

  it('excludes a NULL-currency recovery_event from recovered', async () => {
    const { client } = mockClient({
      claims: [{ claim_id: 'c1', amount_claimed: '500.0000', currency: 'USD', status: 'open' }],
      events: [{ claim_id: 'c1', amount_recovered: '100.0000', currency: null }],
    });
    const result = await getClientRecoverySummary(client, CLIENT_ID);
    expect(result[0]).toMatchObject({ recovered: '0.0000', outstanding: '500.0000' });
  });

  it('excludes a mismatched-currency recovery_event from recovered', async () => {
    const { client } = mockClient({
      claims: [{ claim_id: 'c1', amount_claimed: '500.0000', currency: 'USD', status: 'open' }],
      events: [{ claim_id: 'c1', amount_recovered: '100.0000', currency: 'CAD' }],
    });
    const result = await getClientRecoverySummary(client, CLIENT_ID);
    expect(result[0]).toMatchObject({ recovered: '0.0000', outstanding: '500.0000' });
  });

  it('scopes both queries to the given clientId', async () => {
    const { client, query } = mockClient({ claims: [{ claim_id: 'c1', amount_claimed: '1.0000', currency: 'USD', status: 'open' }] });
    await getClientRecoverySummary(client, CLIENT_ID);
    const claimCall = query.mock.calls.find((c: unknown[]) => (c[0] as string).includes('FROM claim')) as [string, unknown[]];
    expect(claimCall[1]).toEqual([CLIENT_ID]);
  });
});
