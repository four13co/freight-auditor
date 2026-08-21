import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../../src/db/pool.js';

/**
 * 86e2v1bf1: migration 0015 backfills ba_account.issuer for rows that
 * predate the column (any account created under better-auth 1.6.29, this
 * repo's pinned version since 0014, before the 1.7.1 bump this item
 * required). Proves the specific failure the backfill exists to prevent --
 * reproduced against an ephemeral DB before writing the backfill: a NULL
 * issuer on an EXISTING row fully locks that user out of sign-in
 * (better-auth's own account lookup filters on issuer and returns "User not
 * found"/401, not a graceful fallback or an auto-heal). This test simulates
 * that pre-migration state directly (null the column back out after a real
 * sign-up, mirroring what a row from before 0015 would look like), then
 * re-applies 0015's exact backfill statement and confirms sign-in recovers.
 */
describe('ba_account.issuer backfill (DB) -- migration 0015', () => {
  let app: FastifyInstance;
  const tag = `issuerbackfill-${Date.now()}`;
  const email = `${tag}@example.com`;
  const password = 'password123456';
  let originalSecret: string | undefined;
  let originalAppUrl: string | undefined;
  let originalSignupFlag: string | undefined;

  beforeAll(async () => {
    originalSecret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'test-only-session-secret-32-chars-min';
    originalAppUrl = process.env.APP_URL;
    process.env.APP_URL = 'http://localhost:4180';
    // 86e2xcmpg: signs up a real user via the real HTTP route -- needs the
    // public-signup gate open.
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
      await owner.query(`DELETE FROM ba_session WHERE user_id IN (SELECT id FROM app_user WHERE email = $1)`, [email]);
      await owner.query(`DELETE FROM ba_account WHERE user_id IN (SELECT id FROM app_user WHERE email = $1)`, [email]);
      await owner.query(`DELETE FROM app_user WHERE email = $1`, [email]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('a NULL issuer locks sign-in out (401), and 0015\'s backfill statement recovers it (200)', async () => {
    const signUpRes = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email, password, name: 'Issuer Backfill Test' },
    });
    expect(signUpRes.statusCode).toBe(200);

    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query(
        `UPDATE ba_account SET issuer = NULL WHERE user_id = (SELECT id FROM app_user WHERE email = $1)`,
        [email],
      );

      const lockedOutRes = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        payload: { email, password },
      });
      expect(lockedOutRes.statusCode).toBe(401);

      // Exact statement from migrations/0015_better_auth_passkey_and_issuer.sql
      await client.query(
        `UPDATE ba_account SET issuer = 'local:credential' WHERE issuer IS NULL AND provider_id = 'credential'`,
      );

      const recoveredRes = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        payload: { email, password },
      });
      expect(recoveredRes.statusCode).toBe(200);
    } finally {
      client.release();
    }
  });
});
