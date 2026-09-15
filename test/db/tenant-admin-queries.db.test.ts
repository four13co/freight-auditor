import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { listClients } from '../../src/modules/identity/list-clients.js';
import { getClientDetail } from '../../src/modules/identity/get-client-detail.js';
import { updateClient } from '../../src/modules/identity/update-client.js';
import { listTenantMembers } from '../../src/modules/identity/list-tenant-members.js';
import { removeMembership } from '../../src/modules/identity/remove-membership.js';

/**
 * 86e38rdnm: the read/update queries behind the Tenant Admin UI's list,
 * detail, and members surfaces -- listClients/getClientDetail/updateClient
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
      const created = await owner.query(`INSERT INTO client (name, slug) VALUES ('TAQ Client', $1) RETURNING id`, [tag]);
      clientId = created.rows[0].id;

      const user = await owner.query(`INSERT INTO app_user (email, full_name) VALUES ($1, 'TAQ User') RETURNING id`, [`${tag}@example.test`]);
      userId = user.rows[0].id;

      const membership = await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'analyst') RETURNING id`, [userId, clientId]);
      membershipId = membership.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM membership WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM app_user WHERE id = $1`, [userId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('listClients includes the seeded tenant', async () => {
    const rows = await withTenantTx({ internal: true }, (client) => listClients(client, { limit: 200 }));
    expect(rows.some((r) => r.id === clientId && r.name === 'TAQ Client')).toBe(true);
  });

  it('getClientDetail returns branding: null and the real member count for a fresh tenant', async () => {
    const detail = await withTenantTx({ internal: true }, (client) => getClientDetail(client, clientId));
    expect(detail).toMatchObject({ id: clientId, name: 'TAQ Client', isActive: true, branding: null, memberCount: 1 });
  });

  it('getClientDetail returns null for an unknown id', async () => {
    const detail = await withTenantTx({ internal: true }, (client) => getClientDetail(client, '00000000-0000-4000-8000-000000000000'));
    expect(detail).toBeNull();
  });

  it('AC1/Info tab: updateClient patches name and is_active', async () => {
    const updated = await withTenantTx({ internal: true }, (client) => updateClient(client, clientId, { name: 'TAQ Client Renamed', isActive: false }));
    expect(updated).toEqual({ id: clientId, name: 'TAQ Client Renamed', slug: tag, isActive: false });

    const detail = await withTenantTx({ internal: true }, (client) => getClientDetail(client, clientId));
    expect(detail).toMatchObject({ name: 'TAQ Client Renamed', isActive: false });
  });

  it('AC4: listTenantMembers lists the seeded analyst membership with user details', async () => {
    const members = await withTenantTx({ internal: true }, (client) => listTenantMembers(client, clientId));
    expect(members).toEqual([
      { id: membershipId, userId, email: `${tag}@example.test`, fullName: 'TAQ User', role: 'analyst', createdAt: expect.any(Date) },
    ]);
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
