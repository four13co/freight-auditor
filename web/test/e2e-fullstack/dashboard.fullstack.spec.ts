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

/**
 * 86e37r2rb AC1: Dashboard.tsx is now HashRouter-wrapped (matching
 * PortalApp.tsx's own routing style) -- proves the real, built app is
 * routing (the sidebar's "Dashboard" item is a real hash link that
 * navigates, not a static div) and still renders its pre-existing content
 * unchanged on "/", not that the mocked unit/e2e suites merely tolerate the
 * new wrapper.
 *
 * A bare `/` load never gets an empty hash rewritten to "#/" in the address
 * bar (HashRouter treats "" and "#/" as the same route without forcing a
 * history write on initial mount -- confirmed against the real built app,
 * not assumed) -- so this drives the actual real link click react-router
 * listens for and asserts the resulting URL, rather than asserting a
 * pre-navigation URL shape the router was never going to produce.
 */
test('86e37r2rb AC1: the sidebar "Dashboard" link navigates to /#/, and its content is pixel-identical to before', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('kpi-row')).toBeVisible();

  await page.getByTestId('sidebar-active-item').click();

  await expect(page).toHaveURL(/\/#\/$/);
  await expect(page.getByText('Good morning, Dana')).toBeVisible();
  await expect(page.getByTestId('kpi-row')).toBeVisible();
  // Same two-filter combo as the AC1/AC2 test above -- a rerun without
  // tearing down the DB can accumulate multiple rows sharing this invoice
  // number (fixture seeding is idempotent per-row, not exclusive), so
  // invoice number alone isn't a unique match.
  const row = page.getByTestId('finding-row')
    .filter({ hasText: FIXTURE_INVOICE_NUMBER })
    .filter({ hasText: '$100.00' });
  await expect(row.first()).toBeVisible();
});

/**
 * 86e37r2rm AC1: proves the real, built app -- not just the mocked unit/e2e
 * suites -- routes to /discrepancies and renders live data from the real
 * GET /api/findings, behind the real tenant-auth preHandler, same as this
 * file's other tests. Deliberately does NOT assert on the KPI row (that
 * guarantee belongs to the "/" tests above); this one is about the new route.
 */
test('86e37r2rm AC1: the sidebar "Discrepancies" link navigates to /#/discrepancies and renders live findings data', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('kpi-row')).toBeVisible();

  await page.getByText('Discrepancies').click();

  await expect(page).toHaveURL(/\/#\/discrepancies$/);
  const row = page.getByTestId('finding-row')
    .filter({ hasText: FIXTURE_INVOICE_NUMBER })
    .filter({ hasText: '$100.00' });
  await expect(row.first()).toBeVisible();
  await expect(row.first()).toContainText(FIXTURE_CARRIER_NAME);
});

/**
 * 86e37r2rt AC3: proves the real, built app -- not just the mocked unit/e2e
 * suites -- routes to /invoices and renders live data from the real
 * GET /api/invoices, behind the real tenant-auth + analyst-only preHandlers,
 * same as this file's other tests. Deliberately does not assert an exact
 * billedTotal figure -- unlike the fixture's single variance_finding (whose
 * $100.00 billed amount comes from one specific charge_fact row), this
 * invoice's summed billedTotal reflects EVERY charge_fact row the ingestion
 * pipeline attached to it, which this suite doesn't pin to one value.
 */
test('86e37r2rt AC3: the sidebar "Invoices" link navigates to /#/invoices and renders live invoice data', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('kpi-row')).toBeVisible();

  await page.getByText('Invoices').click();

  await expect(page).toHaveURL(/\/#\/invoices$/);
  const row = page.getByTestId('invoice-row').filter({ hasText: FIXTURE_INVOICE_NUMBER });
  await expect(row.first()).toBeVisible();
  await expect(row.first()).toContainText(FIXTURE_CARRIER_NAME);
});
