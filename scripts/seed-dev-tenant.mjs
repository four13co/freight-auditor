#!/usr/bin/env node
// Idempotently seeds the exact client/app_user/membership row the dashboard's
// dev-mode auth headers (web/src/lib/api.ts's authHeaders()) claim (86e2urebj).
//
// Without this, the dashboard's fixed x-client-id/x-user-id headers satisfy
// resolveAuthorizedTenantContext's SHAPE (both headers present) but not its
// CONTENT (a real membership row for that pair) -- tenant-auth.ts's
// membership check still returns null and every /api/findings* call 401s,
// even after the header fix. This script is what makes the claimed pair
// real. Run once per environment (dev DB, or a fresh ephemeral local one);
// safe to re-run (ON CONFLICT DO NOTHING throughout).
//
// Not a migration: migrations/ is append-only schema DDL, not per-environment
// tenant data -- seeding dev fixtures there would be the wrong layer.

import pg from 'pg';

export const DEV_CLIENT_ID = '11111111-1111-1111-1111-111111111111';
export const DEV_USER_ID = '22222222-2222-2222-2222-222222222222';

/**
 * @param {object} [opts]
 * @param {pg.Pool} [opts.pool] - injectable for tests (avoids a real connection)
 * @returns {Promise<void>}
 */
export async function seedDevTenant({ pool } = {}) {
  const ownedPool = !pool;
  const client = pool ?? new pg.Pool({ connectionString: requireDatabaseUrl() });
  try {
    await client.query(
      `INSERT INTO client (id, name, slug) VALUES ($1, 'Dev Dashboard Client', 'dev-dashboard')
       ON CONFLICT (id) DO NOTHING`,
      [DEV_CLIENT_ID],
    );
    // 86e2zfjmb: is_internal=true -- this is the dashboard's own dev-mode
    // identity (Sidebar.tsx's static footer names it "Dana Mercer, Ops
    // analyst"), i.e. an internal analyst, not a bank/client portal member.
    // Before actor-type routing existed this column was irrelevant to the
    // dev-header path (resolveViaDevHeaders never read it), so it was left
    // at its default. Now that App.tsx branches Dashboard vs. the client
    // portal shell on it, this row must say what it has always represented.
    await client.query(
      `INSERT INTO app_user (id, email, full_name, is_internal) VALUES ($1, 'dev-dashboard@example.com', 'Dev Dashboard User', true)
       ON CONFLICT (id) DO NOTHING`,
      [DEV_USER_ID],
    );
    // Retained even though an internal analyst doesn't strictly need a
    // client-scoped membership row -- the dev-header path
    // (resolveViaDevHeaders, tenant-auth.ts) still requires one to satisfy
    // its own membership check, unchanged by this item's No-gos.
    await client.query(
      `INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_admin')
       ON CONFLICT (user_id, client_id) DO NOTHING`,
      [DEV_USER_ID, DEV_CLIENT_ID],
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
  await seedDevTenant();
  console.log(`Seeded dev tenant: client=${DEV_CLIENT_ID} user=${DEV_USER_ID}`);
}
