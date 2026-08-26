import { test, expect } from '@playwright/test';
import { DEV_CLIENT_ID, DEV_USER_ID } from '../../../scripts/seed-dev-tenant.mjs';
import { FIXTURE_CARRIER_NAME, FIXTURE_INVOICE_NUMBER } from '../../../scripts/seed-fullstack-e2e-fixture.mjs';
import { assertSeeded } from '../e2e-fullstack-auth/assert-seeded.js';

// 86e2uv4p0: full-stack e2e -- browser -> real Fastify server -> real
// Postgres. This file has no route interception or fulfilled/faked responses
// anywhere -- everything the dashboard renders here comes from the real GET /api/findings and
// GET /api/findings/summary, behind the real tenant-auth preHandler, against
// a database migrated + seeded (npm run seed:dev for the dev tenant, npm run
// seed:e2e-fullstack-fixture for a deterministic finding) before this suite
// starts -- see web/package.json's test:e2e:fullstack and the CI job in
// .github/workflows/ci.yml.
//
// This suite specifically proves the explicitly enabled dev-header identity
// path. Real better-auth login/session behavior is covered separately by
// e2e-fullstack-auth/real-session.fullstack.spec.ts.

test.beforeAll(async ({ request }) => {
  // The empty-table trap (item's own rabbit hole): a dashboard with zero rows
  // renders successfully, so an assertion written as "the table exists" would
  // pass on an unseeded DB while proving nothing. Fail loudly and specifically
  // here, before any test tries to find the fixture in the DOM and produces a
  // generic locator-timeout that reads like a UI bug instead of a missing seed.
  await assertSeeded(request, {
    check: () => request.get('/api/findings', { headers: { 'x-client-id': DEV_CLIENT_ID, 'x-user-id': DEV_USER_ID } }),
    errorHint: "Has 'npm run seed:dev' and 'npm run seed:e2e-fullstack-fixture' been run against this database?",
    validate: async (res) => ((await res.json()) as { findings: Array<{ invoiceNumber: string | null }> }).findings.some(
      (finding) => finding.invoiceNumber === FIXTURE_INVOICE_NUMBER,
    ),
  });
});

test('AC1/AC2: dashboard loads findings and KPI values from the real API, no mocking', async ({ page }) => {
  await page.goto('/');

  const row = page.getByTestId('finding-row')
    .filter({ hasText: FIXTURE_INVOICE_NUMBER })
    .filter({ hasText: '$100.00' });
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
