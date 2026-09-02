import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { listDisputesDueForResponse } from '../../src/modules/disputes/list-dispute-response-queue.js';

const CLIENT_ID = '30000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-09-02T00:00:00.000Z');

function mockClient(resolved: unknown) {
  const query = vi.fn().mockResolvedValue(resolved);
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('listDisputesDueForResponse', () => {
  it('AC1: includes a dispute whose most recent comm is outbound and older than the threshold', async () => {
    const { client, query } = mockClient({
      rows: [{ id: 'dispute-1', recorded_at: new Date('2026-08-01T00:00:00.000Z') }],
    });

    const result = await listDisputesDueForResponse(client, CLIENT_ID, NOW);

    expect(result).toEqual([{ disputeId: 'dispute-1', lastOutboundAt: '2026-08-01T00:00:00.000Z' }]);
    const call = query.mock.calls[0] as [string, unknown[]];
    const [sql, values] = call;
    expect(sql).toContain('JOIN LATERAL');
    expect(sql).toContain("lc.direction = 'outbound'");
    expect(sql).toContain('make_interval(days => $3)');
    expect(values[0]).toBe(CLIENT_ID);
    expect(values[1]).toBe(NOW.toISOString());
    expect(values[2]).toBe(5);
    expect(values[3]).toEqual(['sent', 'in_progress']);
  });

  it('AC2: the query excludes an inbound-most-recent or non-pending-status dispute via its WHERE clause', async () => {
    // The exclusion itself is enforced entirely in SQL (lc.direction =
    // 'outbound' and d.status = ANY(pending statuses)); a mocked client
    // can't execute that predicate, so this asserts the predicate is
    // present in the emitted SQL rather than re-implementing Postgres.
    const { client, query } = mockClient({ rows: [] });
    await listDisputesDueForResponse(client, CLIENT_ID, NOW);
    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("lc.direction = 'outbound'");
    expect(sql).toContain('d.status = ANY($4::dispute_status[])');
  });

  it('AC2: returns an empty array when nothing is overdue', async () => {
    const { client } = mockClient({ rows: [] });
    const result = await listDisputesDueForResponse(client, CLIENT_ID, NOW);
    expect(result).toEqual([]);
  });

  it('AC3: a dispute with no dispute_comm rows at all produces no row via the INNER LATERAL join', async () => {
    // An INNER (non-LEFT) LATERAL join against a subquery with LIMIT 1 and
    // no matching dispute_comm row drops the outer row entirely -- there is
    // no client-side filtering step this test could exercise instead; this
    // asserts the join is inner (no LEFT JOIN / no ON true fallback path).
    const { client, query } = mockClient({ rows: [] });
    await listDisputesDueForResponse(client, CLIENT_ID, NOW);
    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/JOIN LATERAL[\s\S]*ON true/);
    expect(sql).not.toContain('LEFT JOIN LATERAL');
  });

  it('accepts a caller-supplied thresholdDays', async () => {
    const { client, query } = mockClient({ rows: [] });
    await listDisputesDueForResponse(client, CLIENT_ID, NOW, 10);
    const call = query.mock.calls[0] as [string, unknown[]];
    expect(call[1][2]).toBe(10);
  });

  it('defaults now to the current time when omitted', async () => {
    const { client, query } = mockClient({ rows: [] });
    await listDisputesDueForResponse(client, CLIENT_ID);
    const call = query.mock.calls[0] as [string, unknown[]];
    expect(typeof call[1][1]).toBe('string');
  });
});
