import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../../src/db/pool.js';

/**
 * 86e2v1bdj: 86e2v1bbr wired getAuth().api.getSession() into tenant-auth.ts
 * for session VERIFICATION, but never mounted better-auth's own handler as
 * an HTTP route -- there was no way for a browser to actually create a
 * session (sign-up/sign-in) short of calling auth.api.signInEmail() directly
 * in-process, which is what tenant-auth-session.db.test.ts's test helper
 * does. A login form needs a real endpoint to POST credentials to; this
 * proves /api/auth/* is mounted and behaves like better-auth's own handler
 * (real Postgres, real cookie round-trip -- membership/session tables carry
 * real constraints only Postgres itself enforces).
 */
describe('POST /api/auth/* (DB, e2e) -- better-auth handler mounted', () => {
  let app: FastifyInstance;
  const tag = `authroute-${Date.now()}`;
  let originalSecret: string | undefined;
  let originalAppUrl: string | undefined;
  let originalSignupFlag: string | undefined;

  beforeAll(async () => {
    originalSecret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'test-only-session-secret-32-chars-min';
    originalAppUrl = process.env.APP_URL;
    process.env.APP_URL = 'http://localhost:4180';
    // 86e2xcmpg: this file's whole point is proving the real sign-up/sign-in
    // round trip over HTTP, so it needs the gate open -- same convention as
    // DEV_AUTH_HEADERS. The gate's default-blocked behavior gets its own
    // dedicated test below, which explicitly unsets this for that one case.
    originalSignupFlag = process.env.PUBLIC_SIGNUP_ENABLED;
    process.env.PUBLIC_SIGNUP_ENABLED = '1';

    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();
  });

  afterAll(async () => {
    if (originalSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;
    if (originalAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = originalAppUrl;
    if (originalSignupFlag === undefined) delete process.env.PUBLIC_SIGNUP_ENABLED;
    else process.env.PUBLIC_SIGNUP_ENABLED = originalSignupFlag;

    await app.close();
    const pool = getPool();
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM ba_session WHERE user_id IN (SELECT id FROM app_user WHERE email LIKE $1)`, [`${tag}%`]);
      await owner.query(`DELETE FROM ba_account WHERE user_id IN (SELECT id FROM app_user WHERE email LIKE $1)`, [`${tag}%`]);
      await owner.query(`DELETE FROM app_user WHERE email LIKE $1`, [`${tag}%`]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('signs up a new user via POST /api/auth/sign-up/email', async () => {
    const email = `${tag}-signup@example.com`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email, password: 'password123456', name: 'Route Test User' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.email).toBe(email);
  });

  it('signs in an existing user via POST /api/auth/sign-in/email and sets a session cookie', async () => {
    const email = `${tag}-signin@example.com`;
    await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email, password: 'password123456', name: 'Route Test User 2' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email, password: 'password123456' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.cookies.some((c) => c.name.includes('session'))).toBe(true);
  });

  it('rejects sign-in with the wrong password', async () => {
    const email = `${tag}-wrongpw@example.com`;
    await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email, password: 'password123456', name: 'Route Test User 3' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email, password: 'wrong-password' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('a session created via this route is accepted by GET /api/auth/get-session', async () => {
    const email = `${tag}-getsession@example.com`;
    await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email, password: 'password123456', name: 'Route Test User 4' },
    });
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email, password: 'password123456' },
    });
    const cookieHeader = signIn.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()?.user?.email).toBe(email);
  });

  it('does not gate /api/auth/* behind the tenant-auth preHandler (would be circular -- you need this route to get a session)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/get-session' });
    // No session cookie at all -- better-auth's own handler returns 200 with a
    // null session (not tenant-auth's 401), proving this route isn't wrapped
    // by the findings preHandler.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeNull();
  });

  it('AC1: POST /api/auth/sign-up/email returns 403 and creates no app_user row when PUBLIC_SIGNUP_ENABLED is unset (real route, real DB)', async () => {
    const localFlag = process.env.PUBLIC_SIGNUP_ENABLED;
    delete process.env.PUBLIC_SIGNUP_ENABLED;
    try {
      const email = `${tag}-blocked@example.com`;
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-up/email',
        payload: { email, password: 'password123456', name: 'Blocked Signup' },
      });
      expect(res.statusCode).toBe(403);

      const pool = getPool();
      const owner = await pool.connect();
      try {
        const rows = await owner.query(`SELECT 1 FROM app_user WHERE email = $1`, [email]);
        expect(rows.rowCount).toBe(0);
      } finally {
        owner.release();
      }
    } finally {
      if (localFlag === undefined) delete process.env.PUBLIC_SIGNUP_ENABLED;
      else process.env.PUBLIC_SIGNUP_ENABLED = localFlag;
    }
  });
});
