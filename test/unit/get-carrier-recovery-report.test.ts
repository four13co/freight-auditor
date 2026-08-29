import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { getCarrierRecoveryReport } from '../../src/modules/claims/get-carrier-recovery-report.js';

const CLIENT_ID = '40000000-0000-4000-8000-000000000001';
const CARRIER_ID = '40000000-0000-4000-8000-000000000002';
const CLAIM_ID = '40000000-0000-4000-8000-000000000003';

function mockClient(opts: { claims?: unknown[]; events?: unknown[] } = {}) {
  const { claims = [], events = [] } = opts;
  const query = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('FROM claim c')) return Promise.resolve({ rows: claims });
    if (sql.includes('FROM recovery_event')) return Promise.resolve({ rows: events });
    throw new Error(`unexpected query: ${sql}`);
  });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('getCarrierRecoveryReport', () => {
  it('returns an empty array when the tenant has no claims, without querying recovery_event', async () => {
    const { client, query } = mockClient({ claims: [] });
    const result = await getCarrierRecoveryReport(client, { clientId: CLIENT_ID });
    expect(result).toEqual([]);
    expect(query.mock.calls.some((c: unknown[]) => (c[0] as string).includes('FROM recovery_event'))).toBe(false);
  });

  it('aggregates one claim with no recovery events into a single outstanding bucket', async () => {
    const { client } = mockClient({
      claims: [{ carrier_id: CARRIER_ID, claim_id: CLAIM_ID, amount_claimed: '500.0000', currency: 'USD', status: 'open' }],
      events: [],
    });
    const result = await getCarrierRecoveryReport(client, { clientId: CLIENT_ID });
    expect(result).toEqual([
      {
        carrierId: CARRIER_ID, currency: 'USD', claimed: '500.0000', recovered: '0.0000',
        outstanding: '500.0000', writtenOff: '0.0000', denied: '0.0000',
        nullCurrencyRecovered: '0.0000', mismatchedCurrencyRecovered: '0.0000',
      },
    ]);
  });

  it('passes carrierId through as a query parameter when scoping to one carrier', async () => {
    const { client, query } = mockClient({ claims: [] });
    await getCarrierRecoveryReport(client, { clientId: CLIENT_ID, carrierId: CARRIER_ID });
    const claimCall = query.mock.calls.find((c: unknown[]) => (c[0] as string).includes('FROM claim c'));
    expect(claimCall![1]).toEqual([CLIENT_ID, CARRIER_ID]);
  });

  it('passes null for carrierId when not scoping to one carrier', async () => {
    const { client, query } = mockClient({ claims: [] });
    await getCarrierRecoveryReport(client, { clientId: CLIENT_ID });
    const claimCall = query.mock.calls.find((c: unknown[]) => (c[0] as string).includes('FROM claim c'));
    expect(claimCall![1]).toEqual([CLIENT_ID, null]);
  });

  it('rejects a malformed clientId', async () => {
    const { client } = mockClient();
    await expect(getCarrierRecoveryReport(client, { clientId: 'not-a-uuid' })).rejects.toThrow();
  });
});
