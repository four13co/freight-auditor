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
const findingId = '10000000-0000-4000-8000-000000000001';
const clientId = '10000000-0000-4000-8000-000000000002';
const statusEventId = '10000000-0000-4000-8000-000000000003';

function mockClient(rows: Array<{ id: string; client_id: string; from_status: string; status_event_id: string }>) {
  const query = vi.fn()
    .mockResolvedValueOnce({ rows })
    .mockResolvedValue({ rows: [{ id: statusEventId, created: true }] });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('updateFindingStatus (unit, mocked client)', () => {
  it('returns found: true and passes findingId/toStatus/note as positional params', async () => {
    const { client, query } = mockClient([{ id: findingId, client_id: clientId, from_status: 'open', status_event_id: statusEventId }]);
    const result = await updateFindingStatus(client, findingId, 'in_review', 'analyst note');
    expect(result).toEqual({ found: true });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([findingId, 'in_review', 'analyst note', 'analyst']);
    expect(sql).toMatch(/UPDATE variance_finding/);
    expect(sql).toMatch(/INSERT INTO finding_status_event/);
  });

  it('defaults note to null when omitted', async () => {
    const { client, query } = mockClient([{ id: findingId, client_id: clientId, from_status: 'open', status_event_id: statusEventId }]);
    await updateFindingStatus(client, findingId, 'closed');
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([findingId, 'closed', null, 'analyst']);
  });

  it('returns found: false when the UPDATE affects zero rows (missing or cross-tenant finding)', async () => {
    const { client } = mockClient([]);
    const result = await updateFindingStatus(client, 'missing-id', 'in_review');
    expect(result).toEqual({ found: false });
  });

  it('casts toStatus to variance_status in the query', async () => {
    const { client, query } = mockClient([{ id: findingId, client_id: clientId, from_status: 'open', status_event_id: statusEventId }]);
    await updateFindingStatus(client, findingId, 'disputed');
    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/\$2::variance_status/);
  });
});
