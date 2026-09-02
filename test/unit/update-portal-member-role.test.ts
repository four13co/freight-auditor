import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { updatePortalMemberRole } from '../../src/modules/identity/update-portal-member-role.js';

/**
 * Unit-level coverage of updatePortalMemberRole's query-building and
 * found/not-found branching via a mocked pg client -- no live DB.
 * test/db/portal-admin-routes.db.test.ts covers the same function against
 * real Postgres (RLS isolation, the internal-role exclusion proof, the
 * actual UPDATE + audit_event write).
 */
const membershipId = '10000000-0000-4000-8000-000000000001';
const clientId = '10000000-0000-4000-8000-000000000002';

function mockClient(rows: Array<{ id: string; client_id: string; from_role: string }>) {
  const query = vi.fn()
    .mockResolvedValueOnce({ rows })
    // writeAuditEvent's own INSERT ... RETURNING id, created -- only reached
    // when the UPDATE above actually found a row.
    .mockResolvedValue({ rows: [{ id: 'audit-1', created: true }] });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('updatePortalMemberRole (unit, mocked client)', () => {
  it('returns found: true and passes membershipId/clientId/newRole/portal-roles as positional params', async () => {
    const { client, query } = mockClient([{ id: membershipId, client_id: clientId, from_role: 'client_viewer' }]);
    const result = await updatePortalMemberRole(client, clientId, membershipId, 'client_admin', '10000000-0000-4000-8000-000000000099');
    expect(result).toEqual({ found: true });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([membershipId, clientId, 'client_admin', ['client_viewer', 'client_admin']]);
    expect(sql).toMatch(/UPDATE membership/);
    expect(sql).toMatch(/role = ANY\(\$4::membership_role\[\]\)/);
  });

  it('returns found: false when the UPDATE affects zero rows (missing, cross-tenant, or a non-portal current role)', async () => {
    const { client } = mockClient([]);
    const result = await updatePortalMemberRole(client, clientId, 'missing-id', 'client_admin', '10000000-0000-4000-8000-000000000099');
    expect(result).toEqual({ found: false });
  });

  it('never issues the audit-event write when the UPDATE found no row', async () => {
    const { client, query } = mockClient([]);
    await updatePortalMemberRole(client, clientId, 'missing-id', 'client_admin', '10000000-0000-4000-8000-000000000099');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('casts newRole to membership_role in the query', async () => {
    const { client, query } = mockClient([{ id: membershipId, client_id: clientId, from_role: 'client_admin' }]);
    await updatePortalMemberRole(client, clientId, membershipId, 'client_viewer', '10000000-0000-4000-8000-000000000099');
    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/\$3::membership_role/);
  });

  it('writes an audit event carrying the from/to role transition after a successful update', async () => {
    const { client, query } = mockClient([{ id: membershipId, client_id: clientId, from_role: 'client_viewer' }]);
    await updatePortalMemberRole(client, clientId, membershipId, 'client_admin', '10000000-0000-4000-8000-000000000099');
    expect(query).toHaveBeenCalledTimes(2);
    const [auditSql, auditParams] = query.mock.calls[1] as [string, unknown[]];
    expect(auditSql).toMatch(/INSERT INTO audit_event/);
    // params: id, clientId, entity, entityId, event, actorKind, actorUserId, ruleVersionId, rubricSnapshotId, detail
    expect(auditParams[2]).toBe('membership');
    expect(auditParams[3]).toBe(membershipId);
    expect(auditParams[4]).toBe('membership.role_changed_to_client_admin');
    expect(auditParams[5]).toBe('client');
    expect(auditParams[6]).toBe('10000000-0000-4000-8000-000000000099');
    expect(auditParams[9]).toEqual({ fromRole: 'client_viewer', toRole: 'client_admin' });
  });
});
