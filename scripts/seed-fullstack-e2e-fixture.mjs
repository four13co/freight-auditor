#!/usr/bin/env node
// Seeds one deterministic finding for the full-stack e2e suite (86e2uv4p0) on
// top of the dev tenant seed-dev-tenant.mjs already inserts. seed-dev-tenant
// only creates the client/app_user/membership triple the dev auth headers
// claim -- it does NOT seed any findings, so without this the dashboard would
// render a legitimately-empty table and every assertion written as "the table
// exists" would pass while proving nothing (the item's own "empty-table trap"
// rabbit hole).
//
// 86e2v2hyu: this now runs the REAL engine (parse210 -> lookupContractRate ->
// evaluateInvoice(CONTRACT_RUBRIC) -> persistAuditRun) instead of hand-
// inserting a variance_finding row -- the previous version bypassed the
// entire pipeline (fabricated FIXTURE_BILLED/FIXTURE_VARIANCE_AMOUNT
// constants), which meant a fresh dev DB's one demo-able finding was not
// proof the engine actually works. This fixture's billed LINEHAUL (1000.00)
// against a seeded contract_rate of 900.00 produces a genuine 100.00 USD
// overcharge through CONTRACT.RATE_VARIANCE, the only criterion that ever
// produces a real dollar variance (verified empirically: STANDARD_RUBRIC's
// two other criteria both come back CONFORMED for this fixture, so this
// seeds exactly one variance_finding row, not more).
//
// Charge-code crosswalk: imports the shared stub categorize map
// (src/modules/ingestion/stub-crosswalk.ts, 86e2xcnja) rather than seeding
// the real charge_code_crosswalk table. Tradeoff noted per the item's own
// ask: seeding the real table would be more realistic but couples this
// script to that table's shape for no benefit this fixture needs.
//
// FIXTURE_INVOICE_NUMBER and FIXTURE_CARRIER_NAME are unchanged from before
// this rewrite -- web/test/e2e-fullstack/dashboard.fullstack.spec.ts asserts
// on both verbatim (DOM text match) and must keep passing unmodified.
//
// Idempotent: uses a fixed, recognizable invoice_number and skips re-running
// the pipeline if a finding for it already exists, so re-running the suite
// locally without tearing down the DB doesn't create duplicate rows.

import pg from 'pg';
import { withTenantTx } from '../src/db/tenant-context.js';
import { parse210 } from '../src/modules/ingestion/parse-210.js';
import { evaluateInvoice } from '../src/modules/evaluator/evaluate-invoice.js';
import { persistAuditRun } from '../src/modules/evaluator/persist.js';
import { CONTRACT_RUBRIC } from '../src/modules/rubric-resolver/contract-rubric.js';
import { lookupContractRate } from '../src/modules/rate-engine/rate-lookup.js';
import { stubCategorize } from '../src/modules/ingestion/stub-crosswalk.js';
import { DEV_CLIENT_ID } from './seed-dev-tenant.mjs';

export const FIXTURE_INVOICE_NUMBER = 'E2E-FULLSTACK-001';
export const FIXTURE_CARRIER_NAME = 'E2E Fullstack Carrier';
export const FIXTURE_CONTRACT_RATE = '900.00';

const ISA_210 =
  'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *260703*1200*U*00401*000000009*0*P*>~' +
  'GS*IM*SENDER*RECEIVER*20260703*1200*9*X*004010~';

/**
 * A GOLDEN_210-shaped 210 EDI body carrying FIXTURE_INVOICE_NUMBER instead of
 * edi-golden.ts's own INV210001 -- same footing invoice (declared total
 * 1250.00, LINEHAUL 1000.00 + FUEL 250.00), constructed locally per the
 * item's own note rather than adding a new exported constant to the shared
 * test fixture file (this script isn't a test).
 */
const FIXTURE_EDI_210 =
  ISA_210 +
  'ST*210*0009~' +
  `B3**${FIXTURE_INVOICE_NUMBER}*****1250.00***USD~` +
  'L1*1***1000.00****400****Linehaul~' +
  'L1*2***250.00****405****Fuel Surcharge~' +
  'SE*5*0009~';

// 86e2xcnja: this fixture's L1 codes (400/405) are a subset of the one
// shared stub crosswalk (stub-crosswalk.ts) -- imported rather than
// redefined a third time.
const categorize = stubCategorize;

/**
 * Throws loudly if `persistAuditRun` wrote no variance_finding row for the
 * given audit_run -- the empty-table trap this item explicitly guards
 * against: seeding a run whose findings are invisible to the dashboard
 * (86e2v17p5 not landed, or a regression in its derivation) must fail the
 * seed script, not silently succeed with nothing to demo.
 *
 * @param {pg.PoolClient} client
 * @param {string} auditRunId
 * @returns {Promise<void>}
 */
export async function assertVarianceFindingDerived(client, auditRunId) {
  const result = await client.query(
    `SELECT count(*)::int AS n FROM variance_finding WHERE audit_run_id = $1`,
    [auditRunId],
  );
  if (result.rows[0].n === 0) {
    throw new Error(
      `seed-fullstack-e2e-fixture: persistAuditRun wrote no variance_finding row for audit_run ${auditRunId} -- ` +
        `86e2v17p5's charge_finding -> variance_finding derivation has not landed (or has regressed). ` +
        `Refusing to seed a finding the dashboard would never show.`,
    );
  }
}

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

    const invoice = parse210(FIXTURE_EDI_210, categorize);

    // No ON CONFLICT guard needed on carrier/contract/contract_rate below --
    // carrier.name has no unique constraint (migrations/0004: only scac_code
    // is uniquely indexed, and this fixture never sets one), so a bare
    // ON CONFLICT DO NOTHING here would silently never fire and duplicate
    // carrier rows on every call, verified empirically against a live DB.
    // The idempotency guarantee this whole function relies on is entirely
    // the invoice_number pre-check above -- once that returns early, none of
    // these INSERTs run a second time. That pre-check is the ONLY guard;
    // don't assume any of the individual INSERTs below are safe to re-run
    // outside it.
    await withTenantTx({ clientIds: [DEV_CLIENT_ID], internal: true }, async (client) => {
      const carrier = await client.query(
        `INSERT INTO carrier (name) VALUES ($1) RETURNING id`,
        [FIXTURE_CARRIER_NAME],
      );
      const carrierId = carrier.rows[0].id;

      const contract = await client.query(
        `INSERT INTO contract (client_id, carrier_id, name) VALUES ($1, $2, 'E2E Fullstack Contract') RETURNING id`,
        [DEV_CLIENT_ID, carrierId],
      );
      const version = await client.query(
        `INSERT INTO contract_version (client_id, contract_id, version_label, valid_from) VALUES ($1, $2, 'v1', CURRENT_DATE) RETURNING id`,
        [DEV_CLIENT_ID, contract.rows[0].id],
      );
      const contractVersionId = version.rows[0].id;
      await client.query(
        `INSERT INTO contract_rate (client_id, contract_version_id, category, rate, currency) VALUES ($1, $2, 'LINEHAUL', $3, 'USD')`,
        [DEV_CLIENT_ID, contractVersionId, FIXTURE_CONTRACT_RATE],
      );

      const rate = await lookupContractRate(client, contractVersionId, 'LINEHAUL');
      const result = evaluateInvoice(invoice, CONTRACT_RUBRIC, { linehaulRate: rate });
      const persisted = await persistAuditRun(client, {
        clientId: DEV_CLIENT_ID,
        carrierId,
        invoice,
        result,
        rubricSnapshotId: null,
      });

      await assertVarianceFindingDerived(client, persisted.auditRunId);

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
