import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { updateFindingStatus } from '../../src/modules/findings/update-finding-status.js';

/**
 * Unit-level coverage of updateFindingStatus's query-building and found/
 * not-found branching via a mocked pg client -- no live DB.
 * test/db/update-finding-status.db.test.ts covers the same function against
 * real Postgres (RLS isolation, the actual UPDATE + INSERT pairing, the
 * append-only history) and stays the source of truth for that behavior;
 * this file exists so the default coverage gate (test/db/** excluded) also
 * exercises this module.
 */
function mockClient(rows: Array<{ id: string; client_id: string; from_status: string }>) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('updateFindingStatus (unit, mocked client)', () => {
  it('returns found: true and passes findingId/toStatus/note as positional params', async () => {
    const { client, query } = mockClient([{ id: 'f1', client_id: 'c1', from_status: 'open' }]);
    const result = await updateFindingStatus(client, 'f1', 'in_review', 'analyst note');
    expect(result).toEqual({ found: true });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['f1', 'in_review', 'analyst note']);
    expect(sql).toMatch(/UPDATE variance_finding/);
    expect(sql).toMatch(/INSERT INTO finding_status_event/);
  });

  it('defaults note to null when omitted', async () => {
    const { client, query } = mockClient([{ id: 'f1', client_id: 'c1', from_status: 'open' }]);
    await updateFindingStatus(client, 'f1', 'closed');
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['f1', 'closed', null]);
  });

  it('returns found: false when the UPDATE affects zero rows (missing or cross-tenant finding)', async () => {
    const { client } = mockClient([]);
    const result = await updateFindingStatus(client, 'missing-id', 'in_review');
    expect(result).toEqual({ found: false });
  });

  it('casts toStatus to variance_status in the query', async () => {
    const { client, query } = mockClient([{ id: 'f1', client_id: 'c1', from_status: 'open' }]);
    await updateFindingStatus(client, 'f1', 'disputed');
    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/\$2::variance_status/);
  });
});
