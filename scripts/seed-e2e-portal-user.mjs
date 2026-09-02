#!/usr/bin/env node
// Seeds a real better-auth credentialed PORTAL-MEMBER user (86e2zfjmb) for
// the no-DEV_AUTH_HEADERS e2e harness. seed-e2e-auth-user.mjs's user is now
// marked is_internal=true (see that script's own comment) so it keeps
// routing to the internal Dashboard under App.tsx's new actor-type routing.
// This is the counterpart fixture: a real, non-internal, membership-scoped
// user so the client-portal-shell branch of that routing can be proven end
// to end via a real login, not just a mocked component test.
//
// Reuses DEV_CLIENT_ID from seed-dev-tenant.mjs, same reasoning as
// seed-e2e-auth-user.mjs -- no new client/fixture needed for this harness's
// AC (the portal shell's placeholders don't read any tenant data yet).
//
// Idempotent: signUpEmail errors on an existing email, so this checks for
// the account first and skips creation if already present.
//
// Needs SESSION_SECRET/APP_URL set (better-auth requires both) -- same env
// as the harness's server target, so run this after those are exported.

import pg from 'pg';
import { getAuth } from '../src/auth/better-auth.js';
import { DEV_CLIENT_ID } from './seed-dev-tenant.mjs';

export const E2E_PORTAL_EMAIL = 'e2e-portal-member@example.com';
export const E2E_PORTAL_PASSWORD = 'e2e-portal-member-password-86e2zfjmb';

/**
 * @param {object} [opts]
 * @param {pg.Pool} [opts.pool] - injectable for tests (avoids a real connection)
 * @returns {Promise<void>}
 */
export async function seedE2ePortalUser({ pool } = {}) {
  const ownedPool = !pool;
  const client = pool ?? new pg.Pool({ connectionString: requireDatabaseUrl() });
  try {
    const existing = await client.query(`SELECT id FROM app_user WHERE email = $1`, [E2E_PORTAL_EMAIL]);

    let userId;
    if (existing.rowCount && existing.rowCount > 0) {
      userId = existing.rows[0].id;
    } else {
      const result = await getAuth().api.signUpEmail({
        body: { email: E2E_PORTAL_EMAIL, password: E2E_PORTAL_PASSWORD, name: 'E2E Portal Member User' },
      });
      userId = result.user.id;
    }

    // client_viewer, not client_admin -- deliberately the OTHER role from
    // seed-e2e-auth-user.mjs's fixture, so between the two real-session
    // fixtures this harness exercises both membership roles at least once,
    // not just is_internal true/false.
    await client.query(
      `INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_viewer')
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
  await seedE2ePortalUser();
  console.log(`Seeded e2e portal user: email=${E2E_PORTAL_EMAIL}`);
}
