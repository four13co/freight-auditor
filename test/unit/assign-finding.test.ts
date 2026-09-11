import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { assignFinding } from '../../src/modules/findings/assign-finding.js';

/**
 * Unit-level coverage of assignFinding's query-building and found/not-found
 * branching via a mocked pg client -- no live DB. test/db/assign-finding.db.test.ts
 * covers the same function against real Postgres (RLS isolation, the actual
 * UPDATE, the audit event) and stays the source of truth for that behavior;
 * this file exists so the default coverage gate (test/db/** excluded) also
 * exercises this module.
 */
const findingId = '10000000-0000-4000-8000-000000000001';
const clientId = '10000000-0000-4000-8000-000000000002';
const actorUserId = '10000000-0000-4000-8000-000000000003';
const assignmentEventId = '10000000-0000-4000-8000-000000000004';

function mockClient(rows: Array<{ id: string; client_id: string; assignment_event_id: string }>) {
  const query = vi.fn()
    .mockResolvedValueOnce({ rows })
    .mockResolvedValue({ rows: [{ id: 'audit-event-id', created: true }] });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('assignFinding (unit, mocked client)', () => {
  it('returns found: true and passes findingId/assigneeUserId/actorUserId as positional params', async () => {
    const { client, query } = mockClient([{ id: findingId, client_id: clientId, assignment_event_id: assignmentEventId }]);
    const result = await assignFinding(client, findingId, actorUserId, actorUserId);
    expect(result).toEqual({ found: true });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE variance_finding/);
    expect(sql).toMatch(/SET assigned_to_user_id = \$2/);
    expect(sql).toMatch(/INSERT INTO finding_assignment_event/);
    expect(params).toEqual([findingId, actorUserId, actorUserId]);
  });

  it('passes null to unassign', async () => {
    const { client, query } = mockClient([{ id: findingId, client_id: clientId, assignment_event_id: assignmentEventId }]);
    await assignFinding(client, findingId, null, actorUserId);
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([findingId, null, actorUserId]);
  });

  it('returns found: false when the UPDATE affects zero rows (missing or cross-tenant finding)', async () => {
    const { client } = mockClient([]);
    const result = await assignFinding(client, 'missing-id', actorUserId);
    expect(result).toEqual({ found: false });
  });
});
