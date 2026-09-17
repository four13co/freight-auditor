import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { updateTenantMembership } from '../../src/modules/identity/update-tenant-membership.js';

/**
 * 86e3a75mf: unit-level coverage of updateTenantMembership's query-building
 * and found/not-found branching via a mocked pg client -- no live DB.
 * test/db/tenant-admin-queries.db.test.ts covers the same function against
 * real Postgres (the explicit client_id boundary, the audit-event write).
 */
const membershipId = '20000000-0000-4000-8000-000000000001';
const clientId = '20000000-0000-4000-8000-000000000002';
const actorUserId = '20000000-0000-4000-8000-000000000099';

function mockClient(rows: Array<{ id: string; client_id: string; role: string; is_active: boolean; from_role: string }>) {
  const query = vi.fn()
    .mockResolvedValueOnce({ rows })
    .mockResolvedValue({ rows: [{ id: 'audit-1', created: true }] });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('updateTenantMembership (unit, mocked client)', () => {
  it('AC1: updates the role, scopes the query by client_id, and returns found: true', async () => {
    const { client, query } = mockClient([{ id: membershipId, client_id: clientId, role: 'lead', is_active: true, from_role: 'analyst' }]);
    const result = await updateTenantMembership(client, clientId, membershipId, { role: 'lead' }, actorUserId);
    expect(result).toEqual({ found: true, id: membershipId, role: 'lead', isActive: true });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([membershipId, clientId, 'lead']);
    expect(sql).toMatch(/UPDATE membership/);
    expect(sql).toMatch(/role = \$3::membership_role/);
    expect(sql).toMatch(/WHERE id = \$1 AND client_id = \$2/);
  });

  it('AC2: returns found: false when no row matches (missing id or a different tenant) -- no audit write issued', async () => {
    const { client, query } = mockClient([]);
    const result = await updateTenantMembership(client, clientId, 'missing-id', { role: 'lead' }, actorUserId);
    expect(result).toEqual({ found: false });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('flips is_active without touching role', async () => {
    const { client, query } = mockClient([{ id: membershipId, client_id: clientId, role: 'analyst', is_active: false, from_role: 'analyst' }]);
    const result = await updateTenantMembership(client, clientId, membershipId, { isActive: false }, actorUserId);
    expect(result).toEqual({ found: true, id: membershipId, role: 'analyst', isActive: false });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/is_active = \$3/);
    expect(sql).not.toMatch(/role = /);
    expect(params).toEqual([membershipId, clientId, false]);
  });

  it('updates both role and is_active in one call', async () => {
    const { client, query } = mockClient([{ id: membershipId, client_id: clientId, role: 'lead', is_active: false, from_role: 'analyst' }]);
    await updateTenantMembership(client, clientId, membershipId, { role: 'lead', isActive: false }, actorUserId);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/role = \$3::membership_role/);
    expect(sql).toMatch(/is_active = \$4/);
    expect(params).toEqual([membershipId, clientId, 'lead', false]);
  });

  it('writes an audit event only when the role actually changed', async () => {
    const { client, query } = mockClient([{ id: membershipId, client_id: clientId, role: 'lead', is_active: true, from_role: 'analyst' }]);
    await updateTenantMembership(client, clientId, membershipId, { role: 'lead' }, actorUserId);
    expect(query).toHaveBeenCalledTimes(2);
    const [auditSql, auditParams] = query.mock.calls[1] as [string, unknown[]];
    expect(auditSql).toMatch(/INSERT INTO audit_event/);
    expect(auditParams[2]).toBe('membership');
    expect(auditParams[3]).toBe(membershipId);
    expect(auditParams[4]).toBe('membership.role_changed_to_lead');
    expect(auditParams[5]).toBe('analyst');
    expect(auditParams[6]).toBe(actorUserId);
    expect(auditParams[9]).toEqual({ fromRole: 'analyst', toRole: 'lead' });
  });

  it('does not write an audit event when the submitted role equals the current role', async () => {
    const { client, query } = mockClient([{ id: membershipId, client_id: clientId, role: 'analyst', is_active: true, from_role: 'analyst' }]);
    await updateTenantMembership(client, clientId, membershipId, { role: 'analyst' }, actorUserId);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('does not write an audit event for an is_active-only change', async () => {
    const { client, query } = mockClient([{ id: membershipId, client_id: clientId, role: 'analyst', is_active: false, from_role: 'analyst' }]);
    await updateTenantMembership(client, clientId, membershipId, { isActive: false }, actorUserId);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('no-field call is a pure read scoped by client_id, returning the current row', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: membershipId, role: 'analyst', is_active: true }] });
    const client = { query } as unknown as pg.PoolClient;
    const result = await updateTenantMembership(client, clientId, membershipId, {}, actorUserId);
    expect(result).toEqual({ found: true, id: membershipId, role: 'analyst', isActive: true });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/SELECT id, role, is_active FROM membership WHERE id = \$1 AND client_id = \$2/);
    expect(params).toEqual([membershipId, clientId]);
  });
});
