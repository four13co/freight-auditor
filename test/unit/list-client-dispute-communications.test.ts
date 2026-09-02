import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { listClientDisputeCommunications } from '../../src/modules/portal/list-client-dispute-communications.js';

/**
 * Unit-level coverage of listClientDisputeCommunications, mirroring
 * list-dispute-communications.test.ts's structure exactly -- the added
 * coverage here is the explicit `client_id` predicate (86e31a9ch/#216
 * precedent) that list-dispute-communications.ts deliberately does NOT
 * have (RLS-only).
 */
const DISPUTE_ID = '41000000-0000-4000-8000-000000000001';
const CLIENT_ID = 'client-abc';

describe('listClientDisputeCommunications (unit, mocked client)', () => {
  it('maps rows to camelCase, newest first per the query order', async () => {
    const recordedAtNewer = new Date('2026-09-01T00:00:00.000Z');
    const recordedAtOlder = new Date('2026-08-31T00:00:00.000Z');
    const query = vi.fn().mockResolvedValue({
      rows: [
        { id: 'c2', direction: 'outbound', body: 'Delivery to carrier initiated.', recorded_at: recordedAtNewer },
        { id: 'c1', direction: 'inbound', body: 'Carrier acknowledged.', recorded_at: recordedAtOlder },
      ],
    });
    const client = { query } as unknown as pg.PoolClient;

    const result = await listClientDisputeCommunications(client, CLIENT_ID, DISPUTE_ID);
    expect(result).toEqual([
      { id: 'c2', direction: 'outbound', body: 'Delivery to carrier initiated.', recordedAt: recordedAtNewer },
      { id: 'c1', direction: 'inbound', body: 'Carrier acknowledged.', recordedAt: recordedAtOlder },
    ]);

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ORDER BY recorded_at DESC');
    expect(sql).toMatch(/WHERE dispute_id = \$1 AND client_id = \$2/);
    expect(values).toEqual([DISPUTE_ID, CLIENT_ID]);
  });

  it('returns an empty array when the dispute has no communications (or is not visible to this clientId)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const client = { query } as unknown as pg.PoolClient;
    const result = await listClientDisputeCommunications(client, CLIENT_ID, DISPUTE_ID);
    expect(result).toEqual([]);
  });
});
