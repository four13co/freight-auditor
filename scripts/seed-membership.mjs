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
  // 86e3a76bz (migration 0084): the plain UNIQUE (user_id, account_id)
  // constraint this ON CONFLICT target used to name was replaced by a
  // unique index on (user_id, COALESCE(vendor_id, client_id, account_id))
  // -- see that migration's own header comment for why (a user can now
  // hold a separate Client-/Vendor-level membership in the same account).
  // This seed helper always inserts an Account-level row (client_id/
  // vendor_id both implicitly NULL), so its ON CONFLICT target must name
  // the same expression the new index actually indexes, not the old
  // plain-column pair -- Postgres infers the target index by matching the
  // expression list exactly.
  await client.query(
    `INSERT INTO membership (user_id, account_id, role) VALUES ($1, $2, 'analyst')
     ON CONFLICT (user_id, COALESCE(vendor_id, client_id, account_id)) DO UPDATE SET role = EXCLUDED.role`,
    [userId, clientId],
  );
}
