import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../../src/db/pool.js';

/**
 * 86e2wb92b: a real (non-dev-header) session proves WHO a user is, but
 * nothing told the frontend WHICH client_id to send on subsequent requests
 * -- resolveViaSession still requires an explicit x-client-id header
 * (tenant-auth.ts). GET /api/auth/memberships (app.ts) is the new lookup:
 * given a verified session, return the client_id(s) that user has a
 * membership row for, so login can store one and start sending it as
 * x-client-id (option (b), decided on the ClickUp task).
 *
 * Real Postgres, real sign-up/sign-in round-trip -- membership carries
 * FORCE RLS keyed on client_id (migration 0009), so this can't be proven
 * with a mocked client.
 */
describe('GET /api/auth/memberships (DB, e2e)', () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let clientAId: string;
  let clientBId: string;
  const tag = `authmem-${Date.now()}`;
  let originalSecret: string | undefined;
  let originalAppUrl: string | undefined;

  beforeAll(async () => {
    originalSecret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'test-only-session-secret-32-chars-min';
    originalAppUrl = process.env.APP_URL;
    process.env.APP_URL = 'http://localhost:4180';

    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('AuthMem A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const b = await owner.query(`INSERT INTO client (name, slug) VALUES ('AuthMem B', $1) RETURNING id`, [`${tag}-b`]);
      clientBId = b.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    if (originalSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;
    if (originalAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = originalAppUrl;

    await app.close();
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM membership WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM ba_session WHERE user_id IN (SELECT id FROM app_user WHERE email LIKE $1)`, [`${tag}%`]);
      await owner.query(`DELETE FROM ba_account WHERE user_id IN (SELECT id FROM app_user WHERE email LIKE $1)`, [`${tag}%`]);
      await owner.query(`DELETE FROM app_user WHERE email LIKE $1`, [`${tag}%`]);
      await owner.query(`DELETE FROM client WHERE id IN ($1, $2)`, [clientAId, clientBId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  async function signUpAndSignIn(email: string): Promise<string> {
    await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email, password: 'password123456', name: 'Membership Test User' },
    });
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email, password: 'password123456' },
    });
    return signIn.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  it('AC1: returns the client_id for a user with exactly one membership row', async () => {
    const email = `${tag}-single@example.com`;
    const cookieHeader = await signUpAndSignIn(email);

    const owner = await pool.connect();
    try {
      const u = await owner.query(`SELECT id FROM app_user WHERE email = $1`, [email]);
      await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_viewer')`, [
        u.rows[0].id,
        clientAId,
      ]);
    } finally {
      owner.release();
    }

    const res = await app.inject({ method: 'GET', url: '/api/auth/memberships', headers: { cookie: cookieHeader } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ clientIds: [clientAId] });
  });

  it('returns an empty list for a signed-in user with no membership rows', async () => {
    const email = `${tag}-none@example.com`;
    const cookieHeader = await signUpAndSignIn(email);

    const res = await app.inject({ method: 'GET', url: '/api/auth/memberships', headers: { cookie: cookieHeader } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ clientIds: [] });
  });

  it('returns every client_id for a user with more than one membership row', async () => {
    const email = `${tag}-multi@example.com`;
    const cookieHeader = await signUpAndSignIn(email);

    const owner = await pool.connect();
    try {
      const u = await owner.query(`SELECT id FROM app_user WHERE email = $1`, [email]);
      await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_viewer')`, [
        u.rows[0].id,
        clientAId,
      ]);
      await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_viewer')`, [
        u.rows[0].id,
        clientBId,
      ]);
    } finally {
      owner.release();
    }

    const res = await app.inject({ method: 'GET', url: '/api/auth/memberships', headers: { cookie: cookieHeader } });
    expect(res.statusCode).toBe(200);
    expect(res.json().clientIds.sort()).toEqual([clientAId, clientBId].sort());
  });

  it('returns 401 with no session cookie at all', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/memberships' });
    expect(res.statusCode).toBe(401);
  });
});
