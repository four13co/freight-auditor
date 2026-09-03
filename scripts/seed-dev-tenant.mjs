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

// 86e33t12f: these must be real RFC4122 v4 UUIDs (variant nibble [89ab]) --
// the original all-repeated-digit sentinels failed zod's strict z.uuid(),
// 500ing any module (authorize-payment.ts, persist-contract-extraction.ts)
// that validates a dev-auth clientId/actorUserId that strictly. Kept
// visually recognizable as dev fixtures via the repeated 1s/2s elsewhere in
// the value. Must stay in lockstep with web/src/lib/api.ts's hardcoded
// mirror (its own comment documents the must-match requirement).
export const DEV_CLIENT_ID = '11111111-1111-4111-8111-111111111111';
export const DEV_USER_ID = '22222222-2222-4222-8222-222222222222';

// 86e33trjc: the pre-86e33t12f sentinel ids. A persistent, non-ephemeral
// deploy database (the dev Neon instance) already has 'dev-dashboard'
// client/app_user rows under these OLD ids from every deploy before #319
// merged. ON CONFLICT (id) DO NOTHING doesn't help there: the NEW id's
// INSERT is a genuinely different row, so it collides on the separate
// client_slug_key / app_user_email_key UNIQUE constraints instead of being
// suppressed. reconcileSentinelId (below) migrates any pre-existing row (and
// everything that references it) from the old id to the new one before the
// inserts below run, so they become true no-ops against an
// already-reconciled database -- exactly like they already are against a
// fresh one, where the old row never existed at all.
const OLD_DEV_CLIENT_ID = '11111111-1111-1111-1111-111111111111';
const OLD_DEV_USER_ID = '22222222-2222-2222-2222-222222222222';

/**
 * Migrates a row from oldId to newId in place: copies the old row's own
 * columns (every column, not a hardcoded literal set -- an is_active=false
 * or an old created_at on the real row must survive, not get silently reset)
 * into a new row under newId, repoints every foreign key (in any table) that
 * referenced oldId, then removes the oldId row. Postgres enforces FK NO
 * ACTION checks immediately, so a child can only be repointed to newId once
 * a newId row exists, and the old row can only be deleted once nothing
 * references it -- this ordering is why UPDATE-in-place on the parent's own
 * id column isn't used here (it would require the new id to exist before the
 * row moves and children to move before the old row's id changes, which is
 * circular).
 *
 * uniqueColumn is freed (suffixed) first so the copy's real value doesn't
 * collide with the still-present old row before it's replaced, then
 * regexp_replace strips that same suffix back off in the copy.
 *
 * Both the copied column list and the FK-repoint set come from
 * information_schema, not an enumerated list -- this repo has dozens of
 * tables with a client_id/actor_user_id FK, and a hardcoded list would
 * silently miss the next column or table a migration adds.
 *
 * No-ops if the old row doesn't exist (fresh DB -- nothing to reconcile) or
 * the new one already does (a prior run already reconciled it).
 *
 * @param {pg.Pool} pool
 * @param {{ table: string, uniqueColumn: string, oldId: string, newId: string }} opts
 */
async function reconcileSentinelId(pool, { table, uniqueColumn, oldId, newId }) {
  const { rowCount: oldExists } = await pool.query(`SELECT 1 FROM "${table}" WHERE id = $1`, [oldId]);
  if (oldExists === 0) return;
  const { rowCount: newExists } = await pool.query(`SELECT 1 FROM "${table}" WHERE id = $1`, [newId]);
  if (newExists > 0) return;

  const { rows: columnRows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name <> 'id'
      ORDER BY ordinal_position`,
    [table],
  );
  const columns = columnRows.map((r) => r.column_name);
  const insertColumns = columns.map((c) => `"${c}"`).join(', ');
  const selectList = columns
    .map((c) => (c === uniqueColumn ? `regexp_replace("${c}", '--reconciling-86e33trjc$', '')` : `"${c}"`))
    .join(', ');

  const { rows: fks } = await pool.query(
    `SELECT tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema AND kcu.table_name = tc.table_name
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
        AND ccu.table_name = $1 AND ccu.column_name = 'id'`,
    [table],
  );

  const conn = await pool.connect();
  try {
    await conn.query('BEGIN');
    await conn.query(`UPDATE "${table}" SET "${uniqueColumn}" = "${uniqueColumn}" || '--reconciling-86e33trjc' WHERE id = $1`, [oldId]);
    await conn.query(
      `INSERT INTO "${table}" (id, ${insertColumns}) SELECT $1, ${selectList} FROM "${table}" WHERE id = $2`,
      [newId, oldId],
    );
    for (const { table_name, column_name } of fks) {
      await conn.query(`UPDATE "${table_name}" SET "${column_name}" = $1 WHERE "${column_name}" = $2`, [newId, oldId]);
    }
    await conn.query(`DELETE FROM "${table}" WHERE id = $1`, [oldId]);
    await conn.query('COMMIT');
  } catch (err) {
    await conn.query('ROLLBACK');
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * @param {object} [opts]
 * @param {pg.Pool} [opts.pool] - injectable for tests (avoids a real connection)
 * @returns {Promise<void>}
 */
export async function seedDevTenant({ pool } = {}) {
  const ownedPool = !pool;
  const client = pool ?? new pg.Pool({ connectionString: requireDatabaseUrl() });
  try {
    await reconcileSentinelId(client, {
      table: 'client',
      uniqueColumn: 'slug',
      oldId: OLD_DEV_CLIENT_ID,
      newId: DEV_CLIENT_ID,
    });
    await reconcileSentinelId(client, {
      table: 'app_user',
      uniqueColumn: 'email',
      oldId: OLD_DEV_USER_ID,
      newId: DEV_USER_ID,
    });

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
