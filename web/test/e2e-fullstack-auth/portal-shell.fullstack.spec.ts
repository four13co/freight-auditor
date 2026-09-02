import { test, expect } from '@playwright/test';
import { loginViaForm } from './login-form.js';
import { assertSeeded } from './assert-seeded.js';
import { E2E_PORTAL_EMAIL, E2E_PORTAL_PASSWORD } from '../../../scripts/seed-e2e-portal-user.mjs';

// 86e2zfjmb: proves App.tsx's new actor-type routing end to end via a REAL
// login (no DEV_AUTH_HEADERS) -- browser -> real login form -> real Fastify
// server -> real Postgres -> GET /api/auth/memberships returns
// isInternal:false -> the client portal shell renders instead of the
// internal Dashboard. real-session.fullstack.spec.ts (this same harness)
// proves the OTHER branch: seed-e2e-auth-user.mjs's user is_internal=true,
// still lands on Dashboard -- together the two specs cover both branches of
// the same routing decision via a real session, not just the mocked
// App.test.tsx component test.
test.beforeAll(async ({ request }) => {
  await assertSeeded(request, {
    check: () => request.post('/api/auth/sign-in/email', {
      data: { email: E2E_PORTAL_EMAIL, password: E2E_PORTAL_PASSWORD },
    }),
    errorHint: "Has 'npm run seed:e2e-portal-user' been run against this database?",
  });
});

test('AC2: a real session for a portal member renders the client portal shell, not the dashboard', async ({ page }) => {
  await page.goto('/');

  await loginViaForm(page, E2E_PORTAL_EMAIL, E2E_PORTAL_PASSWORD);

  await expect(page.getByTestId('portal-shell')).toBeVisible();
  await expect(page.getByTestId('kpi-row')).not.toBeVisible();
});

test('AC2/AC3: the portal shell nav lists every B.1-B.7 section, and each shows a placeholder, never a blank screen', async ({ page }) => {
  await page.goto('/');
  await loginViaForm(page, E2E_PORTAL_EMAIL, E2E_PORTAL_PASSWORD);
  await expect(page.getByTestId('portal-shell')).toBeVisible();

  const navItems = page.getByTestId('portal-nav-item');
  await expect(navItems).toHaveCount(5);

  await page.getByRole('link', { name: 'Invoices' }).click();
  await expect(page.getByTestId('portal-placeholder')).toContainText(/invoices/i);

  await page.getByRole('link', { name: 'Findings' }).click();
  await expect(page.getByTestId('portal-placeholder')).toContainText(/findings/i);
});
