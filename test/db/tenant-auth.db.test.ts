import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { resolveAuthorizedTenantContext } from '../../src/modules/findings/tenant-auth.js';

/**
 * 86e2u7j2y ACs, against real Postgres (membership carries FORCE RLS keyed on
 * client_id -- migration 0009 -- so this can't be proven with a mocked client;
 * see test/unit/tenant-auth.test.ts for the header-gating unit coverage).
 *
 * 86e2v1bbr gated the header path behind DEV_AUTH_HEADERS (unset = a
 * verified better-auth session is required instead -- see
 * tenant-auth-session.db.test.ts) -- this suite sets the flag for its own
 * lifetime so it keeps proving exactly what it always proved: the
 * membership-gated dev-header path, unchanged, when the flag is on.
 */
describe('resolveAuthorizedTenantContext (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  let userIdWithMembership: string;
  let userIdWithoutMembership: string;
  let originalFlag: string | undefined;
  const tag = `ta-${Date.now()}`;

  beforeAll(async () => {
    originalFlag = process.env.DEV_AUTH_HEADERS;
    process.env.DEV_AUTH_HEADERS = '1';
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('TA', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;

      const u1 = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-member@example.com`]);
      userIdWithMembership = u1.rows[0].id;
      const u2 = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-nonmember@example.com`]);
      userIdWithoutMembership = u2.rows[0].id;

      await owner.query(
        `INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_viewer')`,
        [userIdWithMembership, clientId],
      );
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    if (originalFlag === undefined) delete process.env.DEV_AUTH_HEADERS;
    else process.env.DEV_AUTH_HEADERS = originalFlag;
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM membership WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM app_user WHERE id = ANY($1)`, [[userIdWithMembership, userIdWithoutMembership]]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('AC2: returns the claimed client scope when a membership row exists for the user+client pair', async () => {
    const ctx = await resolveAuthorizedTenantContext({
      headers: { 'x-client-id': clientId, 'x-user-id': userIdWithMembership },
    } as never);
    expect(ctx).toEqual({ clientIds: [clientId], internal: false });
  });

  it('AC1: returns null when no membership row exists for the claimed user+client pair', async () => {
    const ctx = await resolveAuthorizedTenantContext({
      headers: { 'x-client-id': clientId, 'x-user-id': userIdWithoutMembership },
    } as never);
    expect(ctx).toBeNull();
  });

  it('AC3: returns null when x-client-id is absent', async () => {
    const ctx = await resolveAuthorizedTenantContext({
      headers: { 'x-user-id': userIdWithMembership },
    } as never);
    expect(ctx).toBeNull();
  });

  it('AC3: returns null when x-user-id is absent', async () => {
    const ctx = await resolveAuthorizedTenantContext({
      headers: { 'x-client-id': clientId },
    } as never);
    expect(ctx).toBeNull();
  });
});
