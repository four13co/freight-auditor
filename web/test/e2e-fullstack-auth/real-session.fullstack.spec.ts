import { test, expect } from '@playwright/test';

// 86e2vqggf: proves the REAL better-auth session round trip end to end --
// browser -> real login form -> real Fastify server -> real Postgres, no
// DEV_AUTH_HEADERS/VITE_DEV_AUTH_HEADERS anywhere in this suite (see
// playwright.fullstack-auth.config.ts's header comment for why this needs
// its own build/server/port, separate from both the mocked `web` job and the
// dev-header-stub `web-fullstack` job).
//
// The full chain this suite exercises: sign in via the real login form ->
// better-auth issues a session cookie -> App.tsx's useSession() resolves it
// -> fetchAndStoreClientId() calls GET /api/auth/memberships (86e2wb92b) ->
// the returned client_id lands in sessionStorage -> authHeaders() sends it as
// x-client-id -> tenant-auth.ts's resolveViaSession's membership check passes
// -> the dashboard renders real findings. Any link in that chain breaking
// looks identical from here: an empty/stuck dashboard or a stuck login form,
// so failures are asserted specifically (see beforeAll) rather than left to
// a generic locator timeout.
//
// Credentials come from seed-e2e-auth-user.mjs (run in CI before this suite,
// see the web-fullstack-auth job) -- a real better-auth account created via
// getAuth().api.signUpEmail(...), membership-scoped to the same DEV_CLIENT_ID
// seed-dev-tenant.mjs/seed-e2e-fullstack-fixture.mjs already seed, so no new
// client or finding fixture is needed here.
const E2E_AUTH_EMAIL = 'e2e-real-session@example.com';
const E2E_AUTH_PASSWORD = 'e2e-real-session-password-86e2vqggf';
const FIXTURE_INVOICE_NUMBER = 'E2E-FULLSTACK-001';

test.beforeAll(async ({ request }) => {
  // Same "empty-table trap" guard as dashboard.fullstack.spec.ts: fail loudly
  // here if the seed prerequisites are missing, rather than let a later
  // assertion read as a UI bug.
  const res = await request.post('/api/auth/sign-in/email', {
    data: { email: E2E_AUTH_EMAIL, password: E2E_AUTH_PASSWORD },
  });
  if (!res.ok()) {
    throw new Error(
      `Real-session e2e setup check failed: POST /api/auth/sign-in/email returned ${res.status()}. ` +
        `Has 'npm run seed:e2e-auth-user' been run against this database?`,
    );
  }
});

test('AC1: full login -> dashboard round trip against the real-session (no DEV_AUTH_HEADERS) harness', async ({
  page,
}) => {
  await page.goto('/');

  await page.getByLabel('Email').fill(E2E_AUTH_EMAIL);
  await page.getByLabel('Password').fill(E2E_AUTH_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  const row = page.getByTestId('finding-row').filter({ hasText: FIXTURE_INVOICE_NUMBER });
  await expect(row).toBeVisible();
  await expect(page.getByTestId('kpi-row')).toBeVisible();
});

test('AC2: session persists across a refresh, no re-login required', async ({ page }) => {
  await page.goto('/');

  await page.getByLabel('Email').fill(E2E_AUTH_EMAIL);
  await page.getByLabel('Password').fill(E2E_AUTH_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  const row = page.getByTestId('finding-row').filter({ hasText: FIXTURE_INVOICE_NUMBER });
  await expect(row).toBeVisible();

  await page.reload();

  // No re-login: the login form must not reappear, and the dashboard must
  // still render the same tenant data as before the refresh.
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).not.toBeVisible();
  await expect(row).toBeVisible();
});
