#!/usr/bin/env node
// 86e36yj9d: the client_admin counterpart to seed-e2e-portal-user.mjs's
// client_viewer fixture -- AC4's two-session verification needs a real
// credentialed client_admin session (to drive the browser upload/confirm)
// distinct from the existing client_viewer fixture (to prove the resulting
// audit run independently). Same DEV_CLIENT_ID, same idempotent
// check-then-create shape as that script -- only the role differs.

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
