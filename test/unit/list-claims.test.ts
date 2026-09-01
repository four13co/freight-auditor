import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { listClaims } from '../../src/modules/claims/list-claims.js';

/**
 * Unit-level coverage of listClaims' query-building (WHERE clause, param
 * order, LIMIT/OFFSET vs. the P6.C.1 keyset-cursor branch, row mapping) via
 * a mocked pg client -- no live DB, same pattern as list-gate-failures.test.ts.
 * test/db/claim-recovery-endpoint.db.test.ts covers this function against
 * real Postgres (RLS isolation, the explicit-clientId-predicate proof) and
 * stays the source of truth for that behavior.
 */
function mockRow() {
  return {
    id: 'c1',
    dispute_id: null as string | null,
    amount_claimed: '500.0000',
    currency: 'USD',
    status: 'open',
    opened_at: new Date('2026-01-01T00:00:00Z'),
    aging_deadline_at: null as Date | null,
  };
}

function mockClient(rows: ReturnType<typeof mockRow>[]) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('listClaims (unit, mocked client)', () => {
  it('maps a returned row from snake_case columns to the ClaimRow shape', async () => {
    const { client } = mockClient([mockRow()]);
    const rows = await listClaims(client, 'client-1');
    expect(rows).toEqual([
      {
        id: 'c1', disputeId: null, amountClaimed: '500.0000', currency: 'USD',
        status: 'open', openedAt: new Date('2026-01-01T00:00:00Z'), agingDeadlineAt: null,
      },
    ]);
  });

  it('always filters on client_id, with no status filter by default', async () => {
    const { client, query } = mockClient([]);
    await listClaims(client, 'client-1');
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/client_id = \$1/);
    expect(sql).not.toMatch(/status = /);
    expect(params).toEqual(['client-1', 50, 0]);
  });

  it('adds a status condition and binds it positionally', async () => {
    const { client, query } = mockClient([]);
    await listClaims(client, 'client-1', { status: 'open' });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/status = \$2/);
    expect(params).toEqual(['client-1', 'open', 50, 0]);
  });

  it('honors explicit limit and offset (legacy offset-mode, unchanged by P6.C.1)', async () => {
    const { client, query } = mockClient([]);
    await listClaims(client, 'client-1', { limit: 10, offset: 20 });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/LIMIT \$2 OFFSET \$3/);
    expect(params).toEqual(['client-1', 10, 20]);
  });

  it('orders by opened_at DESC with id ASC as a total-order tiebreaker (P6.C.1)', async () => {
    const { client, query } = mockClient([]);
    await listClaims(client, 'client-1');
    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ORDER BY opened_at DESC, id ASC/);
  });

  it('uses a keyset predicate anchored on the cursor row itself and omits OFFSET when a cursor is given (P6.C.1)', async () => {
    const { client, query } = mockClient([]);
    const cursor = { id: 'c5' };
    await listClaims(client, 'client-1', { cursor, limit: 10 });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    // Anchored on a fresh DB read of the cursor row's own opened_at (via a
    // correlated subquery), not a client-round-tripped timestamp -- node-pg's
    // timestamptz parser truncates to millisecond precision while the column
    // holds microseconds, which silently broke the tie-break on same-instant
    // rows when the timestamp was threaded through as a query parameter.
    expect(sql).toMatch(/FROM claim, \(\s*SELECT opened_at AS anchor_opened_at, id AS anchor_id\s*FROM claim AS cursor_row\s*WHERE cursor_row\.id = \$2 AND cursor_row\.client_id = \$1\s*\) cursor_anchor/);
    expect(sql).toMatch(/\(opened_at < cursor_anchor\.anchor_opened_at OR \(opened_at = cursor_anchor\.anchor_opened_at AND id > cursor_anchor\.anchor_id\)\)/);
    expect(sql).not.toMatch(/OFFSET/);
    expect(sql).toMatch(/LIMIT \$3$/m);
    expect(params).toEqual(['client-1', cursor.id, 10]);
  });

  it('combines a status filter with a cursor, keeping positional params in order', async () => {
    const { client, query } = mockClient([]);
    const cursor = { id: 'c5' };
    await listClaims(client, 'client-1', { status: 'open', cursor, limit: 10 });
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['client-1', 'open', cursor.id, 10]);
  });

  it('returns an empty array when the query has no matching rows', async () => {
    const { client } = mockClient([]);
    const rows = await listClaims(client, 'client-1');
    expect(rows).toEqual([]);
  });
});
