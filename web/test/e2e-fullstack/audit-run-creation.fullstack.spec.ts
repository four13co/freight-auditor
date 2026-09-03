import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DEV_CLIENT_ID, DEV_USER_ID } from '../../../scripts/seed-dev-tenant.mjs';
import { FIXTURE_CARRIER_NAME } from '../../../scripts/seed-fullstack-e2e-fixture.mjs';
import { GOLDEN_210 } from '../../../test/fixtures/edi-golden.js';
import { assertSeeded } from '../e2e-fullstack-auth/assert-seeded.js';

// 86e33qywh: full-stack e2e for the raw-EDI intake path -- browser/API ->
// real Fastify server -> real Postgres, no route mocking, same contract as
// dashboard.fullstack.spec.ts.
//
// Decision (task's own Solution text asks to confirm and note this): there is
// no dedicated raw-EDI upload UI in web/src today (Header.tsx's "New audit
// run" trigger stays disabled -- see dashboard.fullstack.spec.ts's own note
// and audit-runs-endpoint.db.test.ts's identical conclusion). This suite
// therefore drives POST /api/audit-runs directly via Playwright's `request`
// fixture (real HTTP round-trip against the real route, not app.inject) and
// verifies the *rendered* effect through the real Dashboard.
//
// AC1 needs a genuine variance finding, not just a persisted row -- GOLDEN_210
// foots cleanly under the no-contract STANDARD_RUBRIC path, which is CONFORMED
// on every criterion and correctly produces zero variance_finding rows (see
// test/db/audit-runs-endpoint.db.test.ts's own AC1/AC2 split and comment).
// So this reuses the contract_version_id that seed-fullstack-e2e-fixture.mjs
// already seeds for the dev tenant (LINEHAUL rate 900.00 against
// FIXTURE_CARRIER_NAME) -- GOLDEN_210 bills LINEHAUL at 1000.00, producing a
// real 100.00 USD overcharge through CONTRACT.RATE_VARIANCE, the same
// fixture/rate pairing test/db/audit-runs-endpoint.db.test.ts and
// scripts/seed-fullstack-e2e-fixture.mjs itself already rely on. This is
// composition of the existing seeded fixture, not a new fixture format.

let pool: pg.Pool;
let contractVersionId: string;

test.beforeAll(async ({ request }) => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  await assertSeeded(request, {
    check: () => request.get('/api/findings', { headers: { 'x-client-id': DEV_CLIENT_ID, 'x-user-id': DEV_USER_ID } }),
    errorHint: "Has 'npm run seed:dev' been run against this database?",
  });

  const row = await pool.query<{ id: string }>(
    `SELECT cv.id FROM contract_version cv
     JOIN contract c ON c.id = cv.contract_id
     JOIN carrier ca ON ca.id = c.carrier_id
     WHERE ca.name = $1 AND cv.client_id = $2
     ORDER BY cv.id LIMIT 1`,
    [FIXTURE_CARRIER_NAME, DEV_CLIENT_ID],
  );
  if (!row.rows[0]) {
    throw new Error(
      `audit-run-creation.fullstack.spec: no contract_version found for carrier "${FIXTURE_CARRIER_NAME}" / ` +
        `client ${DEV_CLIENT_ID} -- has 'npm run seed:e2e-fullstack-fixture' been run against this database?`,
    );
  }
  contractVersionId = row.rows[0].id;
});

test.afterAll(async () => {
  await pool.end();
});

test('AC1: a valid 210 posted to /api/audit-runs creates an audit run whose findings render in the real Dashboard', async ({ request, page }) => {
  const before = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_run WHERE client_id = $1`, [DEV_CLIENT_ID]);

  const post = await request.post(`/api/audit-runs?contract_version_id=${contractVersionId}`, {
    headers: { 'x-client-id': DEV_CLIENT_ID, 'x-user-id': DEV_USER_ID, 'content-type': 'application/edi-x12' },
    data: GOLDEN_210,
  });
  expect(post.status()).toBe(201);
  const body = await post.json() as { id: string; outcome: string };
  expect(body.outcome).toBe('SCORED');

  const after = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_run WHERE client_id = $1`, [DEV_CLIENT_ID]);
  expect(after.rows[0]!.n).toBe(before.rows[0]!.n + 1);

  await page.goto('/');
  // The finding's own carrier comes from GOLDEN_210's parsed SCAC, not from
  // the seeded contract's carrier (contract_version_id only drives the rate
  // lookup) -- so this asserts on invoice number and the real 100.00 USD
  // overcharge the CONTRACT.RATE_VARIANCE criterion produced, not a carrier name.
  // .first(): a non-torn-down local rerun of this suite submits GOLDEN_210's
  // INV210001 again each time (no idempotency guard on invoice_number, unlike
  // seed-fullstack-e2e-fixture.mjs's own invoice_number pre-check) and
  // produces an additional matching row -- CI always starts from a fresh
  // migrated DB, so this only matters for repeated local runs; the AC only
  // requires that a matching finding renders, not that exactly one does.
  const row = page.getByTestId('finding-row')
    .filter({ hasText: 'INV210001' })
    .filter({ hasText: '$100.00' })
    .first();
  await expect(row).toBeVisible();
});

test('AC2: an unparseable payload posted to /api/audit-runs is rejected and creates no audit run', async ({ request }) => {
  const before = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_run WHERE client_id = $1`, [DEV_CLIENT_ID]);

  const post = await request.post('/api/audit-runs', {
    headers: { 'x-client-id': DEV_CLIENT_ID, 'x-user-id': DEV_USER_ID, 'content-type': 'application/edi-x12' },
    data: 'this is not an EDI document at all, just garbage bytes',
  });
  expect(post.status()).toBeGreaterThanOrEqual(400);
  expect(post.status()).toBeLessThan(500);
  const body = await post.json() as { error: string };
  expect(typeof body.error).toBe('string');

  const after = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_run WHERE client_id = $1`, [DEV_CLIENT_ID]);
  expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
});
