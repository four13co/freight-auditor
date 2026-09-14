import { test, expect } from '@playwright/test';
import { loginViaForm } from './login-form.js';
import { assertSeeded } from './assert-seeded.js';
import { E2E_AUTH_EMAIL, E2E_AUTH_PASSWORD } from '../../../scripts/seed-e2e-auth-user.mjs';
import { E2E_PORTAL_EMAIL, E2E_PORTAL_PASSWORD } from '../../../scripts/seed-e2e-portal-user.mjs';
import { DEV_CLIENT_ID } from '../../../scripts/seed-dev-tenant.mjs';

/**
 * 86e38pz8e: the real (no DEV_AUTH_HEADERS) round trip for the user-profile
 * item's sign-out, profile-identity, and password-change slices -- reuses
 * real-session.fullstack.spec.ts's shared E2E_AUTH_EMAIL (internal analyst)
 * and seed-e2e-portal-user.mjs's E2E_PORTAL_EMAIL (client_viewer) fixtures.
 * Passkey coverage lives in its own passkey.fullstack.spec.ts, unmodified
 * except for the button's new /#/profile location (this item moved it out
 * of Dashboard's header bar).
 */
// 86e38pz8e: two sign-in checks share this file's one `request` fixture
// (APIRequestContext), which -- unlike a fresh single-check beforeAll
// elsewhere in this suite -- persists the FIRST call's session cookie into
// the SECOND call. better-auth's CSRF/origin check only engages once a
// session cookie is present on the request, and Playwright's raw
// request.post() sends no Origin header by default (a real browser always
// does) -- reproduced directly: the second call 403s with
// MISSING_OR_NULL_ORIGIN, the first never does. An explicit Origin header
// matching this config's own baseURL is what a real browser supplies for
// free; this restates the seeding checks, not the app's own auth logic.
const ORIGIN_HEADER = { origin: 'http://localhost:4181' };

test.beforeAll(async ({ request }) => {
  await assertSeeded(request, {
    check: () => request.post('/api/auth/sign-in/email', {
      headers: ORIGIN_HEADER,
      data: { email: E2E_AUTH_EMAIL, password: E2E_AUTH_PASSWORD },
    }),
    errorHint: "Has 'npm run seed:e2e-auth-user' been run against this database?",
  });
  await assertSeeded(request, {
    check: () => request.post('/api/auth/sign-in/email', {
      headers: ORIGIN_HEADER,
      data: { email: E2E_PORTAL_EMAIL, password: E2E_PORTAL_PASSWORD },
    }),
    errorHint: "Has 'npm run seed:e2e-portal-user' been run against this database?",
  });
});

test('AC1: signing out from the Dashboard destroys the real session -- a reload shows the login form, not the dashboard', async ({ page }) => {
  await page.goto('/');
  await loginViaForm(page, E2E_AUTH_EMAIL, E2E_AUTH_PASSWORD);
  await expect(page.getByTestId('kpi-row')).toBeVisible();

  await page.getByTestId('user-menu-trigger').click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();

  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  // The real proof this was a server-side sign-out, not just clearing
  // client-side state: reloading must not silently restore the dashboard
  // via a still-valid session cookie.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByTestId('kpi-row')).not.toBeVisible();
});

test('AC1: signing out from the Portal destroys the real session -- a reload shows the login form, not the portal shell', async ({ page }) => {
  await page.goto('/');
  await loginViaForm(page, E2E_PORTAL_EMAIL, E2E_PORTAL_PASSWORD);
  await expect(page.getByTestId('portal-shell')).toBeVisible();

  await page.getByTestId('user-menu-trigger').click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();

  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByTestId('portal-shell')).not.toBeVisible();
});

test('AC2/AC3: editing the display name on /#/profile persists across a reload (real PATCH /api/profile, real Postgres)', async ({ page }) => {
  await page.goto('/');
  await loginViaForm(page, E2E_AUTH_EMAIL, E2E_AUTH_PASSWORD);
  await expect(page.getByTestId('kpi-row')).toBeVisible();

  await page.getByTestId('user-menu-trigger').click();
  await page.getByRole('menuitem', { name: 'Profile' }).click();
  await expect(page).toHaveURL(/\/#\/profile$/);
  await expect(page.getByTestId('profile-email')).toHaveText(E2E_AUTH_EMAIL);
  await expect(page.getByTestId('profile-role')).toHaveText('Internal analyst');

  const newName = `E2E Renamed ${Date.now()}`;
  await page.getByLabel('Display name').fill(newName);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('profile-identity-saved')).toBeVisible();

  // Reflected in the sidebar's own user menu immediately (no reload needed) --
  // proves the PATCH response, not a stale better-auth session cache, is
  // what drives the displayed name.
  await expect(page.getByText(newName)).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Display name')).toHaveValue(newName);
});

test('AC6: a client_viewer cannot smuggle a role/tenant field through PATCH /api/profile', async ({ page, request }) => {
  await page.goto('/');
  await loginViaForm(page, E2E_PORTAL_EMAIL, E2E_PORTAL_PASSWORD);
  await expect(page.getByTestId('portal-shell')).toBeVisible();

  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

  const res = await request.patch('/api/profile', {
    headers: { ...ORIGIN_HEADER, cookie: cookieHeader, 'x-client-id': DEV_CLIENT_ID, 'content-type': 'application/json' },
    data: { name: 'Still Chris', role: 'client_admin' },
  });
  expect(res.status()).toBe(400);
});

test.describe('password change', () => {
  const PASSWORD_TEST_EMAIL = `password-e2e-${Date.now()}@example.com`;
  const ORIGINAL_PASSWORD = 'password-e2e-original-86e38pz8e';
  const NEW_PASSWORD = 'password-e2e-updated-86e38pz8e';

  test.beforeAll(async ({ request }) => {
    // A fresh account, same reasoning as passkey.fullstack.spec.ts's own
    // fresh account: changing a password must not affect the shared
    // E2E_AUTH_EMAIL fixture other specs in this suite log in with.
    await assertSeeded(request, {
      check: () => request.post('/api/auth/sign-up/email', {
        headers: ORIGIN_HEADER,
        data: { email: PASSWORD_TEST_EMAIL, password: ORIGINAL_PASSWORD, name: 'Password E2E Test' },
      }),
      errorHint: 'Password-change test account sign-up failed.',
    });
    const { withTenantTx } = await import('../../../src/db/tenant-context.js');
    await withTenantTx({ internal: true }, async (client) => {
      await client.query(
        `INSERT INTO membership (user_id, client_id, role)
         SELECT id, $2, 'analyst' FROM app_user WHERE email = $1
         ON CONFLICT (user_id, client_id) DO NOTHING`,
        [PASSWORD_TEST_EMAIL, DEV_CLIENT_ID],
      );
      await client.query(`UPDATE app_user SET is_internal = true WHERE email = $1`, [PASSWORD_TEST_EMAIL]);
    });
  });

  test('AC4/AC5: changing the password takes effect immediately -- old password rejected, new password works', async ({ page }) => {
    await page.goto('/');
    await loginViaForm(page, PASSWORD_TEST_EMAIL, ORIGINAL_PASSWORD);
    await expect(page.getByTestId('kpi-row')).toBeVisible();

    await page.getByTestId('user-menu-trigger').click();
    await page.getByRole('menuitem', { name: 'Profile' }).click();
    await expect(page).toHaveURL(/\/#\/profile$/);

    await page.getByLabel('Current password', { exact: true }).fill(ORIGINAL_PASSWORD);
    await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel('Confirm new password', { exact: true }).fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByTestId('profile-password-saved')).toBeVisible();

    await page.getByTestId('user-menu-trigger').click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    await loginViaForm(page, PASSWORD_TEST_EMAIL, ORIGINAL_PASSWORD);
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByTestId('kpi-row')).not.toBeVisible();

    await page.getByLabel('Email').fill('');
    await page.getByLabel('Password').fill('');
    await loginViaForm(page, PASSWORD_TEST_EMAIL, NEW_PASSWORD);
    // The browser's #/profile hash survives the sign-out (it's part of the
    // URL, not React state) -- Dashboard remounts on re-login and its
    // HashRouter honors that stale hash, so it lands back on /#/profile
    // rather than /#/. The user menu rendering (any authenticated route)
    // is what actually proves the new password worked; kpi-row is /#/-only.
    await expect(page.getByTestId('user-menu-trigger')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sign in' })).not.toBeVisible();
  });
});
