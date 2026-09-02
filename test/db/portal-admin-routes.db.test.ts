import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { buildApp } from '../../src/server/app.js';
import { listPortalMembers } from '../../src/modules/identity/list-portal-members.js';
import { updatePortalMemberRole } from '../../src/modules/identity/update-portal-member-role.js';

/**
 * P6.A.4: GET /api/portal/members and PATCH /api/portal/members/:id/role,
 * exercised at the HTTP layer with DEV_AUTH_HEADERS=1, same pattern as
 * claim-recovery-endpoint.db.test.ts. RLS is FORCE-enabled on membership
 * (migration 0009), so the internal-role exclusion and the explicit
 * client_id predicate can only be proven against a real Postgres, not a
 * mocked client -- see test/unit/{list-portal-members,
 * update-portal-member-role}.test.ts for the query-building unit coverage.
 */
describe('portal-admin routes (DB, e2e)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let clientId: string;
  let otherClientId: string;
  let adminUserId: string;
  let viewerUserId: string;
  let analystUserId: string;
  let adminMembershipId: string;
  let viewerMembershipId: string;
  let analystMembershipId: string;
  let originalFlag: string | undefined;
  const tag = `par-${Date.now()}`;

  beforeAll(async () => {
    originalFlag = process.env.DEV_AUTH_HEADERS;
    process.env.DEV_AUTH_HEADERS = '1';
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('PAR', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const c2 = await owner.query(`INSERT INTO client (name, slug) VALUES ('PAR-other', $1) RETURNING id`, [`${tag}-other`]);
      otherClientId = c2.rows[0].id;

      const uAdmin = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-admin@example.com`]);
      adminUserId = uAdmin.rows[0].id;
      const uViewer = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-viewer@example.com`]);
      viewerUserId = uViewer.rows[0].id;
      const uAnalyst = await owner.query(`INSERT INTO app_user (email, is_internal) VALUES ($1, true) RETURNING id`, [`${tag}-analyst@example.com`]);
      analystUserId = uAnalyst.rows[0].id;

      const mAdmin = await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_admin') RETURNING id`, [adminUserId, clientId]);
      adminMembershipId = mAdmin.rows[0].id;
      const mViewer = await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_viewer') RETURNING id`, [viewerUserId, clientId]);
      viewerMembershipId = mViewer.rows[0].id;
      const mAnalyst = await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'analyst') RETURNING id`, [analystUserId, clientId]);
      analystMembershipId = mAnalyst.rows[0].id;
    } finally {
      owner.release();
    }
    app = buildApp();
  });

  afterAll(async () => {
    if (originalFlag === undefined) delete process.env.DEV_AUTH_HEADERS;
    else process.env.DEV_AUTH_HEADERS = originalFlag;
    await app.close();
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM membership WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM app_user WHERE id = ANY($1)`, [[adminUserId, viewerUserId, analystUserId]]);
      await owner.query(`DELETE FROM client WHERE id = ANY($1)`, [[clientId, otherClientId]]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('a client_admin lists the roster, excluding the internal analyst membership row', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/portal/members', headers: { 'x-client-id': clientId, 'x-user-id': adminUserId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const ids = body.members.map((m: { id: string }) => m.id);
    expect(ids).toEqual(expect.arrayContaining([adminMembershipId, viewerMembershipId]));
    expect(ids).not.toContain(analystMembershipId);
  });

  it('a client_viewer can also list the roster (composite read preHandler)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/portal/members', headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().members.some((m: { id: string }) => m.id === adminMembershipId)).toBe(true);
  });

  it('rejects an unauthenticated list request with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/portal/members' });
    expect(res.statusCode).toBe(401);
  });

  it('a client_admin promotes a client_viewer to client_admin, and it is durably reflected', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/portal/members/${viewerMembershipId}/role`,
      headers: { 'x-client-id': clientId, 'x-user-id': adminUserId, 'content-type': 'application/json' },
      payload: { role: 'client_admin' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: viewerMembershipId, role: 'client_admin' });

    const owner = await pool.connect();
    try {
      const row = await owner.query(`SELECT role FROM membership WHERE id = $1`, [viewerMembershipId]);
      expect(row.rows[0].role).toBe('client_admin');
      const audit = await owner.query(
        `SELECT entity, entity_id, event, actor_kind, actor_user_id, detail FROM audit_event WHERE entity_id = $1 AND event = 'membership.role_changed_to_client_admin'`,
        [viewerMembershipId],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({
        entity: 'membership', actor_kind: 'client', actor_user_id: adminUserId,
        detail: { fromRole: 'client_viewer', toRole: 'client_admin' },
      });
    } finally {
      // restore for later tests in this suite that assume the original role
      await owner.query(`UPDATE membership SET role = 'client_viewer' WHERE id = $1`, [viewerMembershipId]);
      owner.release();
    }
  });

  it('a client_admin cannot touch the internal analyst membership row -- 404, structurally blocked, not just 403', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/portal/members/${analystMembershipId}/role`,
      headers: { 'x-client-id': clientId, 'x-user-id': adminUserId, 'content-type': 'application/json' },
      payload: { role: 'client_viewer' },
    });
    expect(res.statusCode).toBe(404);

    const owner = await pool.connect();
    try {
      const row = await owner.query(`SELECT role FROM membership WHERE id = $1`, [analystMembershipId]);
      expect(row.rows[0].role).toBe('analyst');
    } finally {
      owner.release();
    }
  });

  it('rejects a client_viewer attempting the write route with 401', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/portal/members/${adminMembershipId}/role`,
      headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId, 'content-type': 'application/json' },
      payload: { role: 'client_viewer' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an invalid role value with 400', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/portal/members/${viewerMembershipId}/role`,
      headers: { 'x-client-id': clientId, 'x-user-id': adminUserId, 'content-type': 'application/json' },
      payload: { role: 'analyst' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for a well-formed but nonexistent membership id', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/portal/members/00000000-0000-0000-0000-000000000000/role',
      headers: { 'x-client-id': clientId, 'x-user-id': adminUserId, 'content-type': 'application/json' },
      payload: { role: 'client_admin' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('cross-tenant: a client_admin of one client cannot list or act on another client\'s roster', async () => {
    const cAdmin = await pool.connect();
    let otherAdminUserId: string;
    try {
      const u = await cAdmin.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-other-admin@example.com`]);
      otherAdminUserId = u.rows[0].id;
      await cAdmin.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_admin')`, [otherAdminUserId, otherClientId]);
    } finally {
      cAdmin.release();
    }

    const listRes = await app.inject({
      method: 'GET', url: '/api/portal/members', headers: { 'x-client-id': otherClientId, 'x-user-id': otherAdminUserId },
    });
    expect(listRes.statusCode).toBe(200);
    // otherClientId's roster legitimately contains the caller's own
    // just-created membership row -- the proof is that NONE of clientId's
    // rows leak into it, not that the roster is empty.
    const otherIds = listRes.json().members.map((m: { id: string }) => m.id);
    expect(otherIds).not.toContain(adminMembershipId);
    expect(otherIds).not.toContain(viewerMembershipId);
    expect(otherIds).not.toContain(analystMembershipId);

    const patchRes = await app.inject({
      method: 'PATCH', url: `/api/portal/members/${viewerMembershipId}/role`,
      headers: { 'x-client-id': otherClientId, 'x-user-id': otherAdminUserId, 'content-type': 'application/json' },
      payload: { role: 'client_admin' },
    });
    expect(patchRes.statusCode).toBe(404);

    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM membership WHERE user_id = $1`, [otherAdminUserId]);
      await owner.query(`DELETE FROM app_user WHERE id = $1`, [otherAdminUserId]);
    } finally {
      owner.release();
    }
  });
});

/**
 * Direct module coverage of the explicit client_id predicate on
 * listPortalMembers/updatePortalMemberRole, independent of RLS -- same
 * shape as claim-recovery-endpoint.db.test.ts's own "explicit client_id
 * predicate" block (86e31a9ch/#216 precedent). An internal (cross-client)
 * scope grants RLS-level visibility across every client, so these tests
 * prove the explicit predicate -- not RLS -- is what rejects a mismatched
 * clientId.
 */
describe('portal-admin query modules: explicit client_id predicate (DB)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let userId: string;
  let membershipId: string;
  const tag = `parp-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('PARP-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const u = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}@example.com`]);
      userId = u.rows[0].id;
      const m = await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_viewer') RETURNING id`, [userId, clientAId]);
      membershipId = m.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE client_id = $1`, [clientAId]);
      await owner.query(`DELETE FROM membership WHERE client_id = $1`, [clientAId]);
      await owner.query(`DELETE FROM app_user WHERE id = $1`, [userId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientAId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  const otherClientId = '00000000-0000-4000-8000-000000000099';

  it('the explicit predicate rejects a mismatched clientId on listPortalMembers, even under an internal (cross-client) RLS scope', async () => {
    const rows = await withTenantTx({ internal: true }, (c) => listPortalMembers(c, otherClientId));
    expect(rows.some((r) => r.id === membershipId)).toBe(false);
  });

  it('the explicit predicate rejects a mismatched clientId on updatePortalMemberRole, even under an internal (cross-client) RLS scope', async () => {
    const result = await withTenantTx({ internal: true }, (c) => updatePortalMemberRole(c, otherClientId, membershipId, 'client_admin', userId));
    expect(result.found).toBe(false);
    const check = await withTenantTx({ internal: true }, (c) => listPortalMembers(c, clientAId));
    expect(check.find((r) => r.id === membershipId)?.role).toBe('client_viewer');
  });

  it('the explicit predicate still finds/updates the row under an internal scope when the clientId matches', async () => {
    const rows = await withTenantTx({ internal: true }, (c) => listPortalMembers(c, clientAId));
    expect(rows.some((r) => r.id === membershipId)).toBe(true);

    const result = await withTenantTx({ internal: true }, (c) => updatePortalMemberRole(c, clientAId, membershipId, 'client_admin', userId));
    expect(result.found).toBe(true);
  });
});
