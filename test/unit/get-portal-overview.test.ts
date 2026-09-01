import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { getPortalOverview } from '../../src/modules/portal/get-portal-overview.js';

const CLIENT_ID = '70000000-0000-4000-8000-000000000001';

function mockClient(rows: unknown[]) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('getPortalOverview', () => {
  it('returns the client name for a found row', async () => {
    const { client } = mockClient([{ name: 'Acme Bank' }]);
    const result = await getPortalOverview(client, CLIENT_ID);
    expect(result).toEqual({ clientName: 'Acme Bank' });
  });

  it('returns null when no row is found', async () => {
    const { client } = mockClient([]);
    const result = await getPortalOverview(client, CLIENT_ID);
    expect(result).toBeNull();
  });

  it('scopes the query to the given clientId', async () => {
    const { client, query } = mockClient([{ name: 'Acme Bank' }]);
    await getPortalOverview(client, CLIENT_ID);
    expect(query.mock.calls[0]?.[1]).toEqual([CLIENT_ID]);
  });
});
