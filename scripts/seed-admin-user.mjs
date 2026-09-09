#!/usr/bin/env node
// Idempotently seeds a real better-auth credentialed account for Greg's own
// login (greg@four13.co), scoped as an internal analyst on the existing dev
// tenant. Same shape as seed-e2e-auth-user.mjs: creates the account via
// getAuth().api.signUpEmail(...) rather than hand-writing a ba_account row,
// since better-auth's password hash format is an internal library detail
// (and this repo overrides advanced.database.generateId -- see
// src/auth/better-auth.ts), so creating the account through better-auth's
// own API is the only version-safe way to produce a row it will later
// accept as a valid credential.
//
// Reuses DEV_CLIENT_ID from seed-dev-tenant.mjs rather than a new tenant --
// there is only one tenant in this app today.
//
// 86e367qxx: membership.role is 'analyst', not 'client_admin' -- this is
// Greg's own operator login for the dashboard, not a client-portal account,
// and role is now read (registerAnalystOnlyPreHandler gates dispute
// accept/reject/partial-accept/close and finding reverse on it). The prior
// 'client_admin' choice predates that: its own comment said "the highest
// membership_role that exists today... role isn't yet read anywhere," which
// this item makes no longer true.
//
// Idempotent: signUpEmail errors on an existing email, so this checks for the
// account first and skips creation if already present -- safe to re-run on
// every deploy without tearing down the DB.
//
// Needs SESSION_SECRET/APP_URL set (better-auth requires both) -- resolved
// via 1Password same as the rest of deploy.yml's migrate-database job.
// ADMIN_PASSWORD is likewise a 1Password reference (op://.../App/admin_password),
// never a literal in this file or in deploy.yml.

import pg from 'pg';
import { getAuth } from '../src/auth/better-auth.js';
import { DEV_CLIENT_ID } from './seed-dev-tenant.mjs';

export const ADMIN_EMAIL = 'greg@four13.co';

/**
 * @param {object} [opts]
 * @param {pg.Pool} [opts.pool] - injectable for tests (avoids a real connection)
 * @param {string} [opts.password] - injectable for tests; defaults to process.env.ADMIN_PASSWORD
 * @returns {Promise<void>}
 */
export async function seedAdminUser({ pool, password } = {}) {
  const ownedPool = !pool;
  const client = pool ?? new pg.Pool({ connectionString: requireDatabaseUrl() });
  try {
    const resolvedPassword = password ?? requireAdminPassword();
    const existing = await client.query(`SELECT id FROM app_user WHERE email = $1`, [ADMIN_EMAIL]);

    let userId;
    if (existing.rowCount && existing.rowCount > 0) {
      userId = existing.rows[0].id;
    } else {
      const result = await getAuth().api.signUpEmail({
        body: { email: ADMIN_EMAIL, password: resolvedPassword, name: 'Greg Flint' },
      });
      userId = result.user.id;
    }

    await client.query(
      `INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'analyst')
       ON CONFLICT (user_id, client_id) DO UPDATE SET role = EXCLUDED.role`,
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

function requireAdminPassword() {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) throw new Error('ADMIN_PASSWORD is not set');
  return password;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await seedAdminUser();
  console.log(`Seeded admin user: email=${ADMIN_EMAIL}`);
}
