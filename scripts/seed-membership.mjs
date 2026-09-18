#!/usr/bin/env node
// 86e39qa78: seed-admin-user.mjs, seed-dev-tenant.mjs, and
// seed-e2e-auth-user.mjs each pasted the same
// `INSERT INTO membership ... ON CONFLICT DO UPDATE SET role = EXCLUDED.role`
// line (plus a near-identical multi-paragraph comment explaining the
// 86e367qxx role correction) -- already had to be edited 3x once in one
// window, and would recur on the next such edit. One shared helper for the
// "upsert this user as an internal analyst on this tenant" job every seed
// script needs.
//
// DO UPDATE (not DO NOTHING) so a persistent, already-seeded DB (the dev
// Neon instance) picks up a corrected role on the next deploy -- an
// INSERT-only upsert would leave a stale role there forever (86e367qxx).

/**
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {{ userId: string, clientId: string }} params
 * @returns {Promise<void>}
 */
export async function upsertAnalystMembership(client, { userId, clientId }) {
  await client.query(
    `INSERT INTO membership (user_id, account_id, role) VALUES ($1, $2, 'analyst')
     ON CONFLICT (user_id, account_id) DO UPDATE SET role = EXCLUDED.role`,
    [userId, clientId],
  );
}
