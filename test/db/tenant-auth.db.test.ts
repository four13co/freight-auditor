import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { resolveAuthorizedTenantContext } from '../../src/modules/findings/tenant-auth.js';

/**
 * 86e2u7j2y ACs, against real Postgres (membership carries FORCE RLS keyed on
 * account_id -- migration 0009 -- so this can't be proven with a mocked client;
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
  let inactiveClientId: string;
  let userIdOnInactiveClient: string;
  let userIdWithDisabledMembership: string;
  let originalFlag: string | undefined;
  const tag = `ta-${Date.now()}`;

  beforeAll(async () => {
    originalFlag = process.env.DEV_AUTH_HEADERS;
    process.env.DEV_AUTH_HEADERS = '1';
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO account (name, slug) VALUES ('TA', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const c2 = await owner.query(
        `INSERT INTO account (name, slug, is_active) VALUES ('TA-inactive', $1, false) RETURNING id`,
        [`${tag}-inactive`],
      );
      inactiveClientId = c2.rows[0].id;

      const u1 = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-member@example.com`]);
      userIdWithMembership = u1.rows[0].id;
      const u2 = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-nonmember@example.com`]);
      userIdWithoutMembership = u2.rows[0].id;
      const u3 = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-inactive-client-member@example.com`]);
      userIdOnInactiveClient = u3.rows[0].id;
      const u4 = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-disabled-membership@example.com`]);
      userIdWithDisabledMembership = u4.rows[0].id;

      await owner.query(
        `INSERT INTO membership (user_id, account_id, role) VALUES ($1, $2, 'account_viewer')`,
        [userIdWithMembership, clientId],
      );
      await owner.query(
        `INSERT INTO membership (user_id, account_id, role) VALUES ($1, $2, 'account_viewer')`,
        [userIdOnInactiveClient, inactiveClientId],
      );
      // 86e3a75mf: a membership row that is itself disabled (is_active =
      // false, migration 0082) on an otherwise-active client -- distinct
      // from the userIdOnInactiveClient fixture above, which disables the
      // whole tenant instead.
      await owner.query(
        `INSERT INTO membership (user_id, account_id, role, is_active) VALUES ($1, $2, 'account_viewer', false)`,
        [userIdWithDisabledMembership, clientId],
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
      await owner.query(`DELETE FROM membership WHERE account_id = ANY($1)`, [[clientId, inactiveClientId]]);
      await owner.query(`DELETE FROM app_user WHERE id = ANY($1)`, [
        [userIdWithMembership, userIdWithoutMembership, userIdOnInactiveClient, userIdWithDisabledMembership],
      ]);
      await owner.query(`DELETE FROM account WHERE id = ANY($1)`, [[clientId, inactiveClientId]]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('AC2: returns the claimed client scope when a membership row exists for the user+client pair', async () => {
    const ctx = await resolveAuthorizedTenantContext({
      headers: { 'x-account-id': clientId, 'x-user-id': userIdWithMembership },
    } as never);
    expect(ctx).toEqual({ clientIds: [clientId], internal: false });
  });

  it('AC1: returns null when no membership row exists for the claimed user+client pair', async () => {
    const ctx = await resolveAuthorizedTenantContext({
      headers: { 'x-account-id': clientId, 'x-user-id': userIdWithoutMembership },
    } as never);
    expect(ctx).toBeNull();
  });

  it('AC3: returns null when x-account-id is absent', async () => {
    const ctx = await resolveAuthorizedTenantContext({
      headers: { 'x-user-id': userIdWithMembership },
    } as never);
    expect(ctx).toBeNull();
  });

  it('AC3: returns null when x-user-id is absent', async () => {
    const ctx = await resolveAuthorizedTenantContext({
      headers: { 'x-account-id': clientId },
    } as never);
    expect(ctx).toBeNull();
  });

  it('86e39qa6h: returns null for a member of a deactivated (is_active = false) client, even with a valid membership row', async () => {
    const ctx = await resolveAuthorizedTenantContext({
      headers: { 'x-account-id': inactiveClientId, 'x-user-id': userIdOnInactiveClient },
    } as never);
    expect(ctx).toBeNull();
  });

  it('AC3 (86e3a75mf): returns null for a disabled membership (membership.is_active = false), even on an active client', async () => {
    const ctx = await resolveAuthorizedTenantContext({
      headers: { 'x-account-id': clientId, 'x-user-id': userIdWithDisabledMembership },
    } as never);
    expect(ctx).toBeNull();
  });
});
