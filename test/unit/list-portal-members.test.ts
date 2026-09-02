import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { listPortalMembers } from '../../src/modules/identity/list-portal-members.js';

/**
 * Unit-level coverage of listPortalMembers' query-building (WHERE clause,
 * role restriction, LIMIT/OFFSET vs. the keyset-cursor branch, row mapping)
 * via a mocked pg client -- no live DB. Mirrors list-claims.test.ts's own
 * pattern (P6.C.1 precedent). test/db/portal-admin-routes.db.test.ts covers
 * this function against real Postgres (RLS isolation, the internal-role
 * exclusion proof).
 */
function mockRow() {
  return {
    id: 'm1',
    user_id: 'u1',
    email: 'viewer@example.com',
    role: 'client_viewer' as const,
    created_at: new Date('2026-01-01T00:00:00Z'),
  };
}

function mockClient(rows: ReturnType<typeof mockRow>[]) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('listPortalMembers (unit, mocked client)', () => {
  it('maps a returned row from snake_case columns to the PortalMemberRow shape', async () => {
    const { client } = mockClient([mockRow()]);
    const rows = await listPortalMembers(client, 'client-1');
    expect(rows).toEqual([
      { id: 'm1', userId: 'u1', email: 'viewer@example.com', role: 'client_viewer', createdAt: new Date('2026-01-01T00:00:00Z') },
    ]);
  });

  it('filters on client_id and restricts to the two portal roles only', async () => {
    const { client, query } = mockClient([]);
    await listPortalMembers(client, 'client-1');
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/membership\.client_id = \$1/);
    expect(sql).toMatch(/membership\.role = ANY\(\$2::membership_role\[\]\)/);
    expect(params).toEqual(['client-1', ['client_viewer', 'client_admin'], 50, 0]);
  });

  it('orders by created_at DESC with id ASC as a total-order tiebreaker', async () => {
    const { client, query } = mockClient([]);
    await listPortalMembers(client, 'client-1');
    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ORDER BY membership\.created_at DESC, membership\.id ASC/);
  });

  it('honors explicit limit and offset', async () => {
    const { client, query } = mockClient([]);
    await listPortalMembers(client, 'client-1', { limit: 10, offset: 20 });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/LIMIT \$3 OFFSET \$4/);
    expect(params).toEqual(['client-1', ['client_viewer', 'client_admin'], 10, 20]);
  });

  it('uses a keyset predicate anchored on the cursor row itself and omits OFFSET when a cursor is given', async () => {
    const { client, query } = mockClient([]);
    await listPortalMembers(client, 'client-1', { cursor: { id: 'm5' }, limit: 10 });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/FROM membership AS cursor_row\s*WHERE cursor_row\.id = \$3 AND cursor_row\.client_id = \$1/);
    expect(sql).toMatch(/\(membership\.created_at < cursor_anchor\.anchor_created_at OR \(membership\.created_at = cursor_anchor\.anchor_created_at AND membership\.id > cursor_anchor\.anchor_id\)\)/);
    expect(sql).not.toMatch(/OFFSET/);
    expect(sql).toMatch(/LIMIT \$4$/m);
    expect(params).toEqual(['client-1', ['client_viewer', 'client_admin'], 'm5', 10]);
  });

  it('returns an empty array when the query has no matching rows', async () => {
    const { client } = mockClient([]);
    const rows = await listPortalMembers(client, 'client-1');
    expect(rows).toEqual([]);
  });
});
