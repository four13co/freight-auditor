import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { resolveAuthorizedTenantContext } from '../../src/modules/findings/tenant-auth.js';

/**
 * 86e2v1bbr AC3/AC4, against real Postgres: a verified better-auth session
 * (via a real sign-up + sign-in round-trip, not a mocked one -- membership
 * carries FORCE RLS keyed on client_id per migration 0009, so this can't be
 * proven with a mocked client) resolves the same TenantContext the dev-header
 * path does, gated correctly on whether a membership row exists.
 *
 * DEV_AUTH_HEADERS is explicitly UNSET for this whole suite (the prod
 * default) -- proving the session path is exercised, not silently falling
 * back to the header path. SESSION_SECRET/APP_URL are set to fixed
 * test-only values (never real secrets -- this is a local ephemeral DB).
 */
describe('resolveAuthorizedTenantContext via a real better-auth session (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  const tag = `tas-${Date.now()}`;
  let originalFlag: string | undefined;
  let originalSecret: string | undefined;
  let originalAppUrl: string | undefined;

  beforeAll(async () => {
    originalFlag = process.env.DEV_AUTH_HEADERS;
    delete process.env.DEV_AUTH_HEADERS;
    originalSecret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'test-only-session-secret-32-chars-min';
    originalAppUrl = process.env.APP_URL;
    process.env.APP_URL = 'http://localhost:4180';

    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('TAS', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    if (originalFlag === undefined) delete process.env.DEV_AUTH_HEADERS;
    else process.env.DEV_AUTH_HEADERS = originalFlag;
    if (originalSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;
    if (originalAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = originalAppUrl;

    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM membership WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM ba_session WHERE user_id IN (SELECT id FROM app_user WHERE email LIKE $1)`, [`${tag}%`]);
      await owner.query(`DELETE FROM ba_account WHERE user_id IN (SELECT id FROM app_user WHERE email LIKE $1)`, [`${tag}%`]);
      await owner.query(`DELETE FROM app_user WHERE email LIKE $1`, [`${tag}%`]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  /** Real sign-up + sign-in via better-auth's own API -- the session-creation helper AC3 allows in place of a login UI (out of this item's scope). */
  async function createRealSession(email: string): Promise<Headers> {
    const { getAuth } = await import('../../src/auth/better-auth.js');
    const auth = getAuth();
    await auth.api.signUpEmail({ body: { email, password: 'password123456', name: 'Session Test User' } });
    const signIn = await auth.api.signInEmail({
      body: { email, password: 'password123456' },
      asResponse: true,
    });
    const setCookie = signIn.headers.get('set-cookie');
    const headers = new Headers();
    const cookiePair = setCookie?.split(';')[0];
    if (cookiePair) headers.set('cookie', cookiePair);
    return headers;
  }

  it('AC3: a verified session for a user WITH a membership row resolves the claimed client scope', async () => {
    const email = `${tag}-member@example.com`;
    const sessionHeaders = await createRealSession(email);

    const owner = await pool.connect();
    try {
      const u = await owner.query(`SELECT id FROM app_user WHERE email = $1`, [email]);
      await owner.query(
        `INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_viewer')`,
        [u.rows[0].id, clientId],
      );
    } finally {
      owner.release();
    }

    const headersObj: Record<string, string> = { 'x-client-id': clientId };
    sessionHeaders.forEach((value, key) => { headersObj[key] = value; });

    const ctx = await resolveAuthorizedTenantContext({ headers: headersObj } as never);
    expect(ctx).toEqual({ clientIds: [clientId], internal: false });
  });

  it('AC4: a verified session for a user with NO membership row for the target client is rejected', async () => {
    const email = `${tag}-nonmember@example.com`;
    const sessionHeaders = await createRealSession(email);

    const headersObj: Record<string, string> = { 'x-client-id': clientId };
    sessionHeaders.forEach((value, key) => { headersObj[key] = value; });

    const ctx = await resolveAuthorizedTenantContext({ headers: headersObj } as never);
    expect(ctx).toBeNull();
  });

  it('AC2: the dev x-client-id/x-user-id headers alone (no session, DEV_AUTH_HEADERS unset) are rejected -- the header bypass this AC closes', async () => {
    const owner = await pool.connect();
    let userId: string;
    try {
      const u = await owner.query(
        `INSERT INTO app_user (email) VALUES ($1) RETURNING id`,
        [`${tag}-header-bypass-attempt@example.com`],
      );
      userId = u.rows[0].id;
      await owner.query(
        `INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_viewer')`,
        [userId, clientId],
      );
    } finally {
      owner.release();
    }

    const ctx = await resolveAuthorizedTenantContext({
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
    } as never);
    expect(ctx).toBeNull();
  });
});
