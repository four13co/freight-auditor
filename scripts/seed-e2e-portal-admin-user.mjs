#!/usr/bin/env node
// 86e36yj9d: seeds a real better-auth credentialed CLIENT_ADMIN portal user
// for the no-DEV_AUTH_HEADERS e2e harness. Sibling fixture to
// seed-e2e-portal-user.mjs (which seeds a client_viewer) -- the Uploads
// section's AC1/AC3/AC4/AC5 all need a real client_admin login (the section
// is structurally rejected for client_viewer), and no existing real-session
// fixture carries that role.
//
// Reuses DEV_CLIENT_ID from seed-dev-tenant.mjs, same reasoning as
// seed-e2e-portal-user.mjs -- no new client/fixture needed.
//
// Idempotent: signUpEmail errors on an existing email, so this checks for
// the account first and skips creation if already present.
//
// Needs SESSION_SECRET/APP_URL set (better-auth requires both) -- same env
// as the harness's server target, so run this after those are exported.

import pg from 'pg';
import { getAuth } from '../src/auth/better-auth.js';
import { DEV_CLIENT_ID } from './seed-dev-tenant.mjs';

export const E2E_PORTAL_ADMIN_EMAIL = 'e2e-portal-admin@example.com';
export const E2E_PORTAL_ADMIN_PASSWORD = 'e2e-portal-admin-password-86e36yj9d';

/**
 * @param {object} [opts]
 * @param {pg.Pool} [opts.pool] - injectable for tests (avoids a real connection)
 * @returns {Promise<void>}
 */
export async function seedE2ePortalAdminUser({ pool } = {}) {
  const ownedPool = !pool;
  const client = pool ?? new pg.Pool({ connectionString: requireDatabaseUrl() });
  try {
    const existing = await client.query(`SELECT id FROM app_user WHERE email = $1`, [E2E_PORTAL_ADMIN_EMAIL]);

    let userId;
    if (existing.rowCount && existing.rowCount > 0) {
      userId = existing.rows[0].id;
    } else {
      const result = await getAuth().api.signUpEmail({
        body: { email: E2E_PORTAL_ADMIN_EMAIL, password: E2E_PORTAL_ADMIN_PASSWORD, name: 'E2E Portal Admin User' },
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
  await seedE2ePortalAdminUser();
  console.log(`Seeded e2e portal admin user: email=${E2E_PORTAL_ADMIN_EMAIL}`);
}
