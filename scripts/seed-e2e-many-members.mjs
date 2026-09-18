#!/usr/bin/env node
// 86e3a7d57: seeds MANY_TENANTS_COUNT (>100) client/app_user/membership
// triples for the admin-users-cross-tenant fullstack e2e spec
// (web/test/e2e-fullstack/admin-users-cross-tenant.fullstack.spec.ts). This
// proves the >100-tenant no-silent-drop AC: the OLD fetchAllUsers()
// fan-out capped tenant discovery at GET /api/internal/tenants?limit=100
// (fetchTenantSummaries' own hardcoded cap), so any tenant past the 100th
// never got its members fetched at all. MANY_TENANTS_COUNT deliberately
// exceeds that old cap so the spec's assertion on the LAST seeded tenant's
// member would have failed against the pre-86e3a7d57 fan-out and passes
// only because GET /api/internal/members now pages every tenant via its
// keyset cursor.
//
// Idempotent: pre-checks whether the last tenant in the sequence already
// exists and skips the whole seed if so -- safe to re-run against a
// not-torn-down local DB, same convention as this dir's other seed scripts.
//
// Explicit, spread-out created_at per row (now() - decreasing offset) rather
// than relying on insertion order or the default now(): every INSERT in this
// script runs inside ONE withTenantTx transaction, and Postgres's now()
// returns the same statement/transaction-scoped value for the whole
// transaction -- so without this, every row would land with an IDENTICAL
// created_at, and GET /api/internal/tenants' `ORDER BY created_at DESC`
// (list-clients.ts) would return ties in effectively arbitrary order,
// making which tenant the old 100-cap drops non-deterministic (verified
// empirically: tenant-1 landed within the first 100 anyway on one run).
// Spreading timestamps out guarantees tenant-1 is the OLDEST of this batch
// and tenant-105 the NEWEST, so the cap deterministically excludes tenant-1.

import pg from 'pg';
import { withTenantTx } from '../src/db/tenant-context.js';

export const MANY_TENANTS_COUNT = 105;

export function manyTenantSlug(i) {
  return `e2e-many-tenant-${i}`;
}

export function manyTenantMemberEmail(i) {
  return `e2e-many-user-${i}@example.test`;
}

/**
 * @param {object} [opts]
 * @param {pg.Pool} [opts.pool] - injectable owner-role pool for the pre-check (avoids a real connection in tests)
 * @returns {Promise<void>}
 */
export async function seedManyTenantMembers({ pool } = {}) {
  const ownedPool = !pool;
  const ownerPool = pool ?? new pg.Pool({ connectionString: requireDatabaseUrl() });
  try {
    const existing = await ownerPool.query(`SELECT id FROM account WHERE slug = $1`, [
      manyTenantSlug(MANY_TENANTS_COUNT),
    ]);
    if (existing.rows.length > 0) return;

    await withTenantTx({ internal: true }, async (client) => {
      for (let i = 1; i <= MANY_TENANTS_COUNT; i++) {
        const secondsBeforeNow = MANY_TENANTS_COUNT - i;
        const clientRow = await client.query(
          `INSERT INTO account (name, slug, created_at) VALUES ($1, $2, now() - ($3 || ' seconds')::interval) RETURNING id`,
          [`E2E Many Tenant ${i}`, manyTenantSlug(i), secondsBeforeNow],
        );
        const clientId = clientRow.rows[0].id;

        const userRow = await client.query(
          `INSERT INTO app_user (email, full_name) VALUES ($1, $2) RETURNING id`,
          [manyTenantMemberEmail(i), `E2E Many User ${i}`],
        );
        const userId = userRow.rows[0].id;

        await client.query(
          `INSERT INTO membership (user_id, account_id, role) VALUES ($1, $2, 'account_viewer')`,
          [userId, clientId],
        );
      }
    });
  } finally {
    if (ownedPool) await ownerPool.end();
  }
}

function requireDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return url;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await seedManyTenantMembers();
  console.log(`Seeded ${MANY_TENANTS_COUNT} tenants+members for admin-users-cross-tenant e2e spec.`);
}
