import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { listClients } from '../../src/modules/identity/list-accounts.js';
import { getAccountDetail } from '../../src/modules/identity/get-account-detail.js';
import { updateClient } from '../../src/modules/identity/update-account.js';
import { listTenantMembers } from '../../src/modules/identity/list-tenant-members.js';
import { removeMembership } from '../../src/modules/identity/remove-membership.js';
import { updateTenantMembership } from '../../src/modules/identity/update-tenant-membership.js';
import { listAllTenantMembers } from '../../src/modules/identity/list-all-tenant-members.js';

/**
 * 86e38rdnm: the read/update queries behind the Tenant Admin UI's list,
 * detail, and members surfaces -- listClients/getAccountDetail/updateClient
 * (client carries no RLS -- it's the tenant root, migration 0009's own
 * pairs list excludes it) and listTenantMembers/removeMembership (RLS via
 * an internal context, same as create-membership.ts).
 */
describe('tenant-admin queries (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  let userId: string;
  let membershipId: string;
  const tag = `taq-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const created = await owner.query(`INSERT INTO account (name, slug) VALUES ('TAQ Client', $1) RETURNING id`, [tag]);
      clientId = created.rows[0].id;

      const user = await owner.query(`INSERT INTO app_user (email, full_name) VALUES ($1, 'TAQ User') RETURNING id`, [`${tag}@example.test`]);
      userId = user.rows[0].id;

      const membership = await owner.query(`INSERT INTO membership (user_id, account_id, role) VALUES ($1, $2, 'analyst') RETURNING id`, [userId, clientId]);
      membershipId = membership.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE actor_user_id = $1`, [userId]);
      await owner.query(`DELETE FROM membership WHERE account_id = $1`, [clientId]);
      await owner.query(`DELETE FROM app_user WHERE id = $1`, [userId]);
      await owner.query(`DELETE FROM account WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('listClients includes the seeded tenant', async () => {
    const rows = await withTenantTx({ internal: true }, (client) => listClients(client, { limit: 200 }));
    expect(rows.some((r) => r.id === clientId && r.name === 'TAQ Client')).toBe(true);
  });

  it('getAccountDetail returns branding: null and the real member count for a fresh tenant', async () => {
    const detail = await withTenantTx({ internal: true }, (client) => getAccountDetail(client, clientId));
    expect(detail).toMatchObject({ id: clientId, name: 'TAQ Client', isActive: true, branding: null, memberCount: 1 });
  });

  it('getAccountDetail returns null for an unknown id', async () => {
    const detail = await withTenantTx({ internal: true }, (client) => getAccountDetail(client, '00000000-0000-4000-8000-000000000000'));
    expect(detail).toBeNull();
  });

  it('AC1/Info tab: updateClient patches name and is_active', async () => {
    const updated = await withTenantTx({ internal: true }, (client) => updateClient(client, clientId, { name: 'TAQ Client Renamed', isActive: false }));
    expect(updated).toEqual({ id: clientId, name: 'TAQ Client Renamed', slug: tag, isActive: false });

    const detail = await withTenantTx({ internal: true }, (client) => getAccountDetail(client, clientId));
    expect(detail).toMatchObject({ name: 'TAQ Client Renamed', isActive: false });
  });

  it('AC4: listTenantMembers lists the seeded analyst membership with user details', async () => {
    const members = await withTenantTx({ internal: true }, (client) => listTenantMembers(client, clientId));
    expect(members).toEqual([
      { id: membershipId, userId, email: `${tag}@example.test`, fullName: 'TAQ User', role: 'analyst', createdAt: expect.any(Date) },
    ]);
  });

  it('86e39qa6m: a non-internal context scoped to a different tenant cannot read this tenant\'s members (RLS)', async () => {
    const members = await withTenantTx({ clientIds: ['00000000-0000-4000-8000-000000000000'], internal: false }, (client) =>
      listTenantMembers(client, clientId),
    );
    expect(members).toEqual([]);
  });

  it('AC1: updateTenantMembership changes the role and writes a membership.role_changed_to_<role> audit event', async () => {
    const result = await withTenantTx({ internal: true }, (client) =>
      updateTenantMembership(client, clientId, membershipId, { role: 'lead' }, userId),
    );
    expect(result).toEqual({ found: true, id: membershipId, role: 'lead', isActive: true });

    const owner = await pool.connect();
    try {
      const events = await owner.query(
        `SELECT event, detail FROM audit_event WHERE entity = 'membership' AND entity_id = $1`,
        [membershipId],
      );
      expect(events.rows).toEqual([
        { event: 'membership.role_changed_to_lead', detail: { fromRole: 'analyst', toRole: 'lead' } },
      ]);
    } finally {
      owner.release();
    }
  });

  it('AC2: updateTenantMembership returns found: false for a membership scoped to a different tenant, and changes nothing', async () => {
    const otherTenant = await withTenantTx({ internal: true }, (client) => client.query(`INSERT INTO account (name, slug) VALUES ('TAQ Other', $1) RETURNING id`, [`${tag}-other`]));
    const otherClientId = otherTenant.rows[0].id;
    try {
      const result = await withTenantTx({ internal: true }, (client) =>
        updateTenantMembership(client, otherClientId, membershipId, { role: 'account_admin' }, userId),
      );
      expect(result).toEqual({ found: false });

      const members = await withTenantTx({ internal: true }, (client) => listTenantMembers(client, clientId));
      expect(members[0]?.role).toBe('lead');
    } finally {
      await withTenantTx({ internal: true }, (client) => client.query(`DELETE FROM account WHERE id = $1`, [otherClientId]));
    }
  });

  it('AC3: updateTenantMembership disables a membership (is_active: false) and writes no audit event for it', async () => {
    const before = await pool.connect();
    let beforeCount: number;
    try {
      beforeCount = (await before.query(`SELECT count(*)::int AS n FROM audit_event WHERE entity = 'membership' AND entity_id = $1`, [membershipId])).rows[0].n;
    } finally {
      before.release();
    }

    const result = await withTenantTx({ internal: true }, (client) =>
      updateTenantMembership(client, clientId, membershipId, { isActive: false }, userId),
    );
    expect(result).toEqual({ found: true, id: membershipId, role: 'lead', isActive: false });

    const owner = await pool.connect();
    try {
      const afterCount = (await owner.query(`SELECT count(*)::int AS n FROM audit_event WHERE entity = 'membership' AND entity_id = $1`, [membershipId])).rows[0].n;
      expect(afterCount).toBe(beforeCount);
    } finally {
      owner.release();
    }

    // re-activate so downstream tests (removeMembership, and the cross-tenant
    // listAllTenantMembers assertions below) see this row in its normal state.
    await withTenantTx({ internal: true }, (client) => updateTenantMembership(client, clientId, membershipId, { isActive: true }, userId));
  });

  it('AC4: listAllTenantMembers aggregates membership rows across tenants, keyed by their own client', async () => {
    const other = await withTenantTx({ internal: true }, (client) => client.query(`INSERT INTO account (name, slug) VALUES ('TAQ Cross', $1) RETURNING id`, [`${tag}-cross`]));
    const otherClientId = other.rows[0].id;
    const otherUser = await withTenantTx({ internal: true }, (client) => client.query(`INSERT INTO app_user (email, full_name) VALUES ($1, 'TAQ Cross User') RETURNING id`, [`${tag}-cross@example.test`]));
    const otherUserId = otherUser.rows[0].id;
    const otherMembership = await withTenantTx({ internal: true }, (client) =>
      client.query(`INSERT INTO membership (user_id, account_id, role) VALUES ($1, $2, 'account_viewer') RETURNING id`, [otherUserId, otherClientId]),
    );
    const otherMembershipId = otherMembership.rows[0].id;

    try {
      const rows = await withTenantTx({ internal: true }, (client) => listAllTenantMembers(client, { limit: 200 }));
      const ids = rows.map((r) => r.id);
      expect(ids).toEqual(expect.arrayContaining([membershipId, otherMembershipId]));
      expect(rows.find((r) => r.id === otherMembershipId)).toMatchObject({
        accountId: otherClientId, accountName: 'TAQ Cross', email: `${tag}-cross@example.test`, role: 'account_viewer', isActive: true,
      });

      // AC4's keyset-cursor boundary case: page with limit=1 across both
      // tenants' rows and confirm every seeded row is recovered exactly
      // once, no drops or duplicates (same shape as
      // list-gate-failures.db.test.ts's own P6.C.1 boundary proof).
      const seen: string[] = [];
      let cursor: { id: string } | undefined;
      for (let i = 0; i < rows.length + 1; i++) {
        const page = await withTenantTx({ internal: true }, (client) => listAllTenantMembers(client, { limit: 1, cursor }));
        if (page.length === 0) break;
        seen.push(page[0]!.id);
        cursor = { id: page[0]!.id };
      }
      expect(seen).toEqual(expect.arrayContaining([membershipId, otherMembershipId]));
      expect(new Set(seen).size).toBe(seen.length);
    } finally {
      await withTenantTx({ internal: true }, (client) => client.query(`DELETE FROM membership WHERE account_id = $1`, [otherClientId]));
      await withTenantTx({ internal: true }, (client) => client.query(`DELETE FROM app_user WHERE id = $1`, [otherUserId]));
      await withTenantTx({ internal: true }, (client) => client.query(`DELETE FROM account WHERE id = $1`, [otherClientId]));
    }
  });

  it('removeMembership deletes the row and reports found: false on a repeat', async () => {
    const first = await withTenantTx({ internal: true }, (client) => removeMembership(client, clientId, membershipId));
    expect(first).toEqual({ found: true });

    const members = await withTenantTx({ internal: true }, (client) => listTenantMembers(client, clientId));
    expect(members).toEqual([]);

    const second = await withTenantTx({ internal: true }, (client) => removeMembership(client, clientId, membershipId));
    expect(second).toEqual({ found: false });
  });
});
