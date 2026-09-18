import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { resolveAccountViewerContext } from '../../src/modules/identity/account-viewer-auth.js';

/**
 * P6.A.2, against real Postgres: membership carries FORCE RLS keyed on
 * account_id (migration 0009), so the role lookup can't be proven with a
 * mocked client -- see test/unit/client-viewer-auth.test.ts for the
 * header/session-gating unit coverage (mocked withTenantTx).
 *
 * DEV_AUTH_HEADERS is set for this whole suite, mirroring
 * tenant-auth.db.test.ts's own convention -- the session path's real-DB
 * proof is covered indirectly via the mocked-getSession unit tests plus
 * tenant-auth-session.db.test.ts's existing end-to-end proof that
 * getAuth()/getSession() (reused unmodified here via toFetchHeaders) works
 * against a real session.
 */
describe('resolveAccountViewerContext (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  let otherClientId: string;
  let inactiveClientId: string;
  let viewerUserId: string;
  let adminUserId: string;
  let analystUserId: string;
  let nonMemberUserId: string;
  let viewerUserIdOnInactiveClient: string;
  let originalFlag: string | undefined;
  const tag = `cva-${Date.now()}`;

  beforeAll(async () => {
    originalFlag = process.env.DEV_AUTH_HEADERS;
    process.env.DEV_AUTH_HEADERS = '1';
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO account (name, slug) VALUES ('CVA', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const c2 = await owner.query(`INSERT INTO account (name, slug) VALUES ('CVA-other', $1) RETURNING id`, [`${tag}-other`]);
      otherClientId = c2.rows[0].id;
      const c3 = await owner.query(
        `INSERT INTO account (name, slug, is_active) VALUES ('CVA-inactive', $1, false) RETURNING id`,
        [`${tag}-inactive`],
      );
      inactiveClientId = c3.rows[0].id;

      const uViewer = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-viewer@example.com`]);
      viewerUserId = uViewer.rows[0].id;
      const uAdmin = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-admin@example.com`]);
      adminUserId = uAdmin.rows[0].id;
      const uAnalyst = await owner.query(
        `INSERT INTO app_user (email, is_internal) VALUES ($1, true) RETURNING id`,
        [`${tag}-analyst@example.com`],
      );
      analystUserId = uAnalyst.rows[0].id;
      const uNonMember = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-nonmember@example.com`]);
      nonMemberUserId = uNonMember.rows[0].id;
      const uInactiveClientViewer = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [
        `${tag}-inactive-client-viewer@example.com`,
      ]);
      viewerUserIdOnInactiveClient = uInactiveClientViewer.rows[0].id;

      await owner.query(`INSERT INTO membership (user_id, account_id, role) VALUES ($1, $2, 'account_viewer')`, [
        viewerUserId,
        clientId,
      ]);
      await owner.query(`INSERT INTO membership (user_id, account_id, role) VALUES ($1, $2, 'account_viewer')`, [
        viewerUserIdOnInactiveClient,
        inactiveClientId,
      ]);
      await owner.query(`INSERT INTO membership (user_id, account_id, role) VALUES ($1, $2, 'account_admin')`, [
        adminUserId,
        clientId,
      ]);
      await owner.query(`INSERT INTO membership (user_id, account_id, role) VALUES ($1, $2, 'analyst')`, [
        analystUserId,
        clientId,
      ]);
      // viewerUserId has NO membership row against otherClientId -- proves cross-client isolation below.
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    if (originalFlag === undefined) delete process.env.DEV_AUTH_HEADERS;
    else process.env.DEV_AUTH_HEADERS = originalFlag;
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM membership WHERE account_id = ANY($1)`, [[clientId, otherClientId, inactiveClientId]]);
      await owner.query(`DELETE FROM app_user WHERE id = ANY($1)`, [
        [viewerUserId, adminUserId, analystUserId, nonMemberUserId, viewerUserIdOnInactiveClient],
      ]);
      await owner.query(`DELETE FROM account WHERE id = ANY($1)`, [[clientId, otherClientId, inactiveClientId]]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('grants { clientIds: [clientId], internal: false } for a client_viewer membership', async () => {
    const ctx = await resolveAccountViewerContext({
      headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId },
    } as never);
    expect(ctx).toEqual({ clientIds: [clientId], internal: false });
  });

  it('rejects a client_admin membership on the same client -- sibling capability, out of this task\'s scope', async () => {
    const ctx = await resolveAccountViewerContext({
      headers: { 'x-client-id': clientId, 'x-user-id': adminUserId },
    } as never);
    expect(ctx).toBeNull();
  });

  it('rejects an internal analyst membership', async () => {
    const ctx = await resolveAccountViewerContext({
      headers: { 'x-client-id': clientId, 'x-user-id': analystUserId },
    } as never);
    expect(ctx).toBeNull();
  });

  it('rejects a user with no membership row at all', async () => {
    const ctx = await resolveAccountViewerContext({
      headers: { 'x-client-id': clientId, 'x-user-id': nonMemberUserId },
    } as never);
    expect(ctx).toBeNull();
  });

  it('rejects a real client_viewer against a client they are not a member of (cross-tenant isolation)', async () => {
    const ctx = await resolveAccountViewerContext({
      headers: { 'x-client-id': otherClientId, 'x-user-id': viewerUserId },
    } as never);
    expect(ctx).toBeNull();
  });

  it('86e39qa6h: rejects a client_viewer membership on a deactivated (is_active = false) client', async () => {
    const ctx = await resolveAccountViewerContext({
      headers: { 'x-client-id': inactiveClientId, 'x-user-id': viewerUserIdOnInactiveClient },
    } as never);
    expect(ctx).toBeNull();
  });
});
