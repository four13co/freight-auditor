#!/usr/bin/env node
// Seeds a real better-auth credentialed user (86e2vqggf) for the
// no-DEV_AUTH_HEADERS e2e harness. seed-dev-tenant.mjs's app_user row has no
// ba_account/password row -- nothing to sign in as via a real login form.
// This script creates one via getAuth().api.signUpEmail(...) rather than
// hand-writing a ba_account row: better-auth's password hash format is an
// internal detail of the library (and this repo already overrides
// advanced.database.generateId -- see src/auth/better-auth.ts), so creating
// the account through better-auth's own API is the only version-safe way to
// produce a row it will later accept as a valid credential.
//
// Reuses DEV_CLIENT_ID from seed-dev-tenant.mjs rather than seeding a new
// client: seed:e2e-fullstack-fixture's E2E-FULLSTACK-001 finding is already
// visible to any user with a membership row against that client, so no new
// finding/fixture seeding is needed for this harness's AC1 (dashboard loads
// tenant findings after real login).
//
// Idempotent: signUpEmail errors on an existing email, so this checks for
// the account first and skips creation if already present -- must be safe
// to re-run locally without tearing down the DB, same as every other seed
// script here.
//
// Needs SESSION_SECRET/APP_URL set (better-auth requires both) -- same env
// as the harness's server target, so run this after those are exported.

import pg from 'pg';
import { getAuth } from '../src/auth/better-auth.js';
import { DEV_CLIENT_ID } from './seed-dev-tenant.mjs';

export const E2E_AUTH_EMAIL = 'e2e-real-session@example.com';
export const E2E_AUTH_PASSWORD = 'e2e-real-session-password-86e2vqggf';

/**
 * @param {object} [opts]
 * @param {pg.Pool} [opts.pool] - injectable for tests (avoids a real connection)
 * @returns {Promise<void>}
 */
export async function seedE2eAuthUser({ pool } = {}) {
  const ownedPool = !pool;
  const client = pool ?? new pg.Pool({ connectionString: requireDatabaseUrl() });
  try {
    const existing = await client.query(`SELECT id FROM app_user WHERE email = $1`, [E2E_AUTH_EMAIL]);

    let userId;
    if (existing.rowCount && existing.rowCount > 0) {
      userId = existing.rows[0].id;
    } else {
      const result = await getAuth().api.signUpEmail({
        body: { email: E2E_AUTH_EMAIL, password: E2E_AUTH_PASSWORD, name: 'E2E Real Session User' },
      });
      userId = result.user.id;
    }

    await client.query(
      `INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_admin')
       ON CONFLICT (user_id, client_id) DO NOTHING`,
      [userId, DEV_CLIENT_ID],
    );
  } finally {
    if (ownedPool) await client.end();
  }
}

function requireDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return url;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await seedE2eAuthUser();
  console.log(`Seeded e2e auth user: email=${E2E_AUTH_EMAIL}`);
}
