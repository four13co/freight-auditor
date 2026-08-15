import { test, expect } from '@playwright/test';

// 86e2uv4p0: full-stack e2e -- browser -> real Fastify server -> real
// Postgres. This file has no route interception or fulfilled/faked responses
// anywhere -- everything the dashboard renders here comes from the real GET /api/findings and
// GET /api/findings/summary, behind the real tenant-auth preHandler, against
// a database migrated + seeded (npm run seed:dev for the dev tenant, npm run
// seed:e2e-fullstack-fixture for a deterministic finding) before this suite
// starts -- see web/package.json's test:e2e:fullstack and the CI job in
// .github/workflows/ci.yml.
//
// This proves the app works with the DEV AUTH STUB (the fixed x-client-id/
// x-user-id headers web/src/lib/api.ts sends). It does NOT prove
// authentication works -- there isn't any real auth yet (86e2urn3e is the
// still-open decision on that). A green run here means "the dev stub's
// contract holds end-to-end," nothing more.

const DEV_CLIENT_ID = '11111111-1111-1111-1111-111111111111';
const DEV_USER_ID = '22222222-2222-2222-2222-222222222222';
const FIXTURE_INVOICE_NUMBER = 'E2E-FULLSTACK-001';
const FIXTURE_CARRIER_NAME = 'E2E Fullstack Carrier';

test.beforeAll(async ({ request }) => {
  // The empty-table trap (item's own rabbit hole): a dashboard with zero rows
  // renders successfully, so an assertion written as "the table exists" would
  // pass on an unseeded DB while proving nothing. Fail loudly and specifically
  // here, before any test tries to find the fixture in the DOM and produces a
  // generic locator-timeout that reads like a UI bug instead of a missing seed.
  const res = await request.get('/api/findings', {
    headers: { 'x-client-id': DEV_CLIENT_ID, 'x-user-id': DEV_USER_ID },
  });
  if (!res.ok()) {
    throw new Error(
      `Full-stack e2e setup check failed: GET /api/findings returned ${res.status()}. ` +
        `Has 'npm run seed:dev' been run against this database?`,
    );
  }
  const body = (await res.json()) as { findings: Array<{ invoiceNumber: string | null }> };
  const hasFixture = body.findings.some((f) => f.invoiceNumber === FIXTURE_INVOICE_NUMBER);
  if (!hasFixture) {
    throw new Error(
      `Full-stack e2e setup check failed: no finding with invoiceNumber="${FIXTURE_INVOICE_NUMBER}" found. ` +
        `Has 'npm run seed:e2e-fullstack-fixture' been run against this database? ` +
        `(Found ${body.findings.length} finding(s) total.)`,
    );
  }
});

test('AC1/AC2: dashboard loads findings and KPI values from the real API, no mocking', async ({ page }) => {
  await page.goto('/');

  const row = page.getByTestId('finding-row').filter({ hasText: FIXTURE_INVOICE_NUMBER });
  await expect(row).toBeVisible();
  await expect(row).toContainText(FIXTURE_CARRIER_NAME);

  // KPI row is real-endpoint-sourced too (getFindingsSummary), not asserting a
  // fixed number (a local rerun without tearing down the DB accumulates
  // fixture rows across runs, since the fixture seed is idempotent on
  // invoice_number but earlier ad-hoc rows from manual testing could still be
  // present) -- just that it rendered from a real response, not the
  // loading/error placeholder.
  await expect(page.getByTestId('kpi-row')).toBeVisible();
});
