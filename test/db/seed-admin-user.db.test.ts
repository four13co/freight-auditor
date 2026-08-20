import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../../src/db/pool.js';
import { DEV_CLIENT_ID } from '../../scripts/seed-dev-tenant.mjs';
import { seedAdminUser, ADMIN_EMAIL } from '../../scripts/seed-admin-user.mjs';

/**
 * Seeds a real better-auth credentialed account for greg@four13.co, scoped
 * client_admin on the existing dev tenant (the highest membership_role that
 * exists today -- role isn't yet read anywhere in tenant-auth.ts's
 * authorization check, so this is the correct/highest label available, not
 * a functional escalation beyond ordinary membership). Same shape as
 * seed-e2e-auth-user.mjs's db coverage: creates via getAuth().api.signUpEmail
 * rather than hand-writing a ba_account row.
 */
describe('seedAdminUser (DB)', () => {
  const password = 'test-only-admin-password-1234567890';
  let originalSecret: string | undefined;
  let originalAppUrl: string | undefined;

  beforeAll(() => {
    originalSecret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'test-only-session-secret-32-chars-min';
    originalAppUrl = process.env.APP_URL;
    process.env.APP_URL = 'http://localhost:4180';
  });

  afterAll(async () => {
    if (originalSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;
    if (originalAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = originalAppUrl;

    const pool = getPool();
    await pool.query(`DELETE FROM ba_session WHERE user_id IN (SELECT id FROM app_user WHERE email = $1)`, [
      ADMIN_EMAIL,
    ]);
    await pool.query(`DELETE FROM ba_account WHERE user_id IN (SELECT id FROM app_user WHERE email = $1)`, [
      ADMIN_EMAIL,
    ]);
    await pool.query(`DELETE FROM membership WHERE user_id IN (SELECT id FROM app_user WHERE email = $1)`, [
      ADMIN_EMAIL,
    ]);
    await pool.query(`DELETE FROM app_user WHERE email = $1`, [ADMIN_EMAIL]);
    await closePool();
  });

  it('creates a real credentialed app_user + client_admin membership on the dev tenant', async () => {
    const pool = getPool();
    await seedAdminUser({ pool, password });

    const user = await pool.query(`SELECT id FROM app_user WHERE email = $1`, [ADMIN_EMAIL]);
    expect(user.rowCount).toBe(1);
    const userId = user.rows[0].id;

    const account = await pool.query(`SELECT 1 FROM ba_account WHERE user_id = $1`, [userId]);
    expect(account.rowCount).toBe(1);

    const membership = await pool.query(
      `SELECT role FROM membership WHERE user_id = $1 AND client_id = $2`,
      [userId, DEV_CLIENT_ID],
    );
    expect(membership.rowCount).toBe(1);
    expect(membership.rows[0].role).toBe('client_admin');
  });

  it('is idempotent: running it twice does not error or duplicate the account/membership', async () => {
    const pool = getPool();
    await seedAdminUser({ pool, password });
    await seedAdminUser({ pool, password }); // second run must not throw

    const user = await pool.query(`SELECT id FROM app_user WHERE email = $1`, [ADMIN_EMAIL]);
    expect(user.rowCount).toBe(1);
    const userId = user.rows[0].id;

    const membership = await pool.query(
      `SELECT count(*) FROM membership WHERE user_id = $1 AND client_id = $2`,
      [userId, DEV_CLIENT_ID],
    );
    expect(Number(membership.rows[0].count)).toBe(1);
  });
});
