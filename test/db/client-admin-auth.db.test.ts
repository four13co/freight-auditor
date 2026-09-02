import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { resolveClientAdminContext } from '../../src/modules/identity/client-admin-auth.js';

/**
 * P6.A.3, against real Postgres: membership carries FORCE RLS keyed on
 * client_id (migration 0009), so the role lookup can't be proven with a
 * mocked client -- see test/unit/client-admin-auth.test.ts for the
 * header/session-gating unit coverage (mocked withTenantTx).
 *
 * DEV_AUTH_HEADERS is set for this whole suite, mirroring
 * client-viewer-auth.db.test.ts's own convention -- the session path's
 * real-DB proof is covered indirectly via the mocked-getSession unit tests
 * plus tenant-auth-session.db.test.ts's existing end-to-end proof that
 * getAuth()/getSession() (reused unmodified here via toFetchHeaders) works
 * against a real session.
 */
describe('resolveClientAdminContext (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  let otherClientId: string;
  let adminUserId: string;
  let viewerUserId: string;
  let analystUserId: string;
  let nonMemberUserId: string;
  let originalFlag: string | undefined;
  const tag = `caa-${Date.now()}`;

  beforeAll(async () => {
    originalFlag = process.env.DEV_AUTH_HEADERS;
    process.env.DEV_AUTH_HEADERS = '1';
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('CAA', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const c2 = await owner.query(`INSERT INTO client (name, slug) VALUES ('CAA-other', $1) RETURNING id`, [`${tag}-other`]);
      otherClientId = c2.rows[0].id;

      const uAdmin = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-admin@example.com`]);
      adminUserId = uAdmin.rows[0].id;
      const uViewer = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-viewer@example.com`]);
      viewerUserId = uViewer.rows[0].id;
      const uAnalyst = await owner.query(
        `INSERT INTO app_user (email, is_internal) VALUES ($1, true) RETURNING id`,
        [`${tag}-analyst@example.com`],
      );
      analystUserId = uAnalyst.rows[0].id;
      const uNonMember = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-nonmember@example.com`]);
      nonMemberUserId = uNonMember.rows[0].id;

      await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_admin')`, [
        adminUserId,
        clientId,
      ]);
      await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_viewer')`, [
        viewerUserId,
        clientId,
      ]);
      await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'analyst')`, [
        analystUserId,
        clientId,
      ]);
      // adminUserId has NO membership row against otherClientId -- proves cross-client isolation below.
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    if (originalFlag === undefined) delete process.env.DEV_AUTH_HEADERS;
    else process.env.DEV_AUTH_HEADERS = originalFlag;
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM membership WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM app_user WHERE id = ANY($1)`, [
        [adminUserId, viewerUserId, analystUserId, nonMemberUserId],
      ]);
      await owner.query(`DELETE FROM client WHERE id = ANY($1)`, [[clientId, otherClientId]]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('grants { clientIds: [clientId], internal: false } for a client_admin membership', async () => {
    const ctx = await resolveClientAdminContext({
      headers: { 'x-client-id': clientId, 'x-user-id': adminUserId },
    } as never);
    expect(ctx).toEqual({ clientIds: [clientId], internal: false });
  });

  it('rejects a client_viewer membership on the same client -- sibling capability, out of this task\'s scope', async () => {
    const ctx = await resolveClientAdminContext({
      headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    } as never);
    expect(ctx).toBeNull();
  });

  it('rejects an internal analyst membership', async () => {
    const ctx = await resolveClientAdminContext({
      headers: { 'x-client-id': clientId, 'x-user-id': analystUserId },
    } as never);
    expect(ctx).toBeNull();
  });

  it('rejects a user with no membership row at all', async () => {
    const ctx = await resolveClientAdminContext({
      headers: { 'x-client-id': clientId, 'x-user-id': nonMemberUserId },
    } as never);
    expect(ctx).toBeNull();
  });

  it('rejects a real client_admin against a client they are not a member of (cross-tenant isolation)', async () => {
    const ctx = await resolveClientAdminContext({
      headers: { 'x-client-id': otherClientId, 'x-user-id': adminUserId },
    } as never);
    expect(ctx).toBeNull();
  });
});
