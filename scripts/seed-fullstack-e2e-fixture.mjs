#!/usr/bin/env node
// Seeds one deterministic finding for the full-stack e2e suite (86e2uv4p0) on
// top of the dev tenant seed-dev-tenant.mjs already inserts. seed-dev-tenant
// only creates the client/app_user/membership triple the dev auth headers
// claim -- it does NOT seed any findings, so without this the dashboard would
// render a legitimately-empty table and every assertion written as "the table
// exists" would pass while proving nothing (the item's own "empty-table trap"
// rabbit hole). Mirrors the invoice -> audit_run -> charge_fact ->
// variance_finding chain test/db/findings-endpoint.db.test.ts already uses,
// scoped to the same DEV_CLIENT_ID the dev auth headers claim (via the real
// withTenantTx, not a hand-rolled RLS scope) so the seeded row is visible
// through the real preHandler with no extra wiring.
//
// Idempotent: uses a fixed, recognizable invoice_number and skips re-inserting
// if a finding for it already exists, so re-running the suite locally without
// tearing down the DB doesn't create duplicate rows that would break the
// "assert exactly one row" style checks in the suite.

import pg from 'pg';
import { withTenantTx } from '../src/db/tenant-context.js';
import { DEV_CLIENT_ID } from './seed-dev-tenant.mjs';

export const FIXTURE_INVOICE_NUMBER = 'E2E-FULLSTACK-001';
export const FIXTURE_CARRIER_NAME = 'E2E Fullstack Carrier';
export const FIXTURE_BILLED = '1234.5600';
export const FIXTURE_VARIANCE_AMOUNT = '234.5600';

/**
 * @param {object} [opts]
 * @param {pg.Pool} [opts.pool] - injectable owner-role pool for the pre-check (avoids a real connection in tests)
 * @returns {Promise<void>}
 */
export async function seedFullstackE2eFixture({ pool } = {}) {
  const ownedPool = !pool;
  const ownerPool = pool ?? new pg.Pool({ connectionString: requireDatabaseUrl() });
  try {
    const existing = await ownerPool.query(`SELECT id FROM invoice WHERE invoice_number = $1`, [
      FIXTURE_INVOICE_NUMBER,
    ]);
    if (existing.rows.length > 0) return;

    await withTenantTx({ clientIds: [DEV_CLIENT_ID], internal: true }, async (client) => {
      const carrier = await client.query(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [
        FIXTURE_CARRIER_NAME,
      ]);
      const inv = await client.query(
        `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version)
         VALUES ($1, $2, '210', $3, 'USD', 'e2e-fullstack') RETURNING id`,
        [DEV_CLIENT_ID, carrier.rows[0].id, FIXTURE_INVOICE_NUMBER],
      );
      const run = await client.query(
        `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'e2e-fullstack', 'SCORED') RETURNING id`,
        [DEV_CLIENT_ID, inv.rows[0].id],
      );
      const cf = await client.query(
        `INSERT INTO charge_fact (client_id, invoice_id, code, category, amount, currency) VALUES ($1, $2, '400', 'LINEHAUL', $3, 'USD') RETURNING id`,
        [DEV_CLIENT_ID, inv.rows[0].id, FIXTURE_BILLED],
      );
      await client.query(
        `INSERT INTO variance_finding (client_id, audit_run_id, charge_fact_id, direction, variance_amount, currency, status)
         VALUES ($1, $2, $3, 'OVERCHARGE', $4, 'USD', 'open')`,
        [DEV_CLIENT_ID, run.rows[0].id, cf.rows[0].id, FIXTURE_VARIANCE_AMOUNT],
      );
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
  await seedFullstackE2eFixture();
  console.log(`Seeded full-stack e2e fixture: invoice=${FIXTURE_INVOICE_NUMBER}`);
}
