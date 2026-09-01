import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { listDisputeCommunications } from '../../src/modules/disputes/list-dispute-communications.js';

const DISPUTE_ID = '41000000-0000-4000-8000-000000000001';

describe('listDisputeCommunications', () => {
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

    const result = await listDisputeCommunications(client, DISPUTE_ID);
    expect(result).toEqual([
      { id: 'c2', direction: 'outbound', body: 'Delivery to carrier initiated.', recordedAt: recordedAtNewer },
      { id: 'c1', direction: 'inbound', body: 'Carrier acknowledged.', recordedAt: recordedAtOlder },
    ]);

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ORDER BY recorded_at DESC');
    expect(values).toEqual([DISPUTE_ID]);
  });

  it('returns an empty array when the dispute has no communications (or is not visible under RLS)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const client = { query } as unknown as pg.PoolClient;
    const result = await listDisputeCommunications(client, DISPUTE_ID);
    expect(result).toEqual([]);
  });
});
