import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DEV_USER_ID } from '../../../scripts/seed-dev-tenant.mjs';
import { assertSeeded } from '../e2e-fullstack-auth/assert-seeded.js';

// 86e38rdnm: full-stack e2e for the Tenant Admin UI -- real Fastify server +
// real Postgres + real browser, no route mocking. Drives the actual
// create-tenant -> configure-branding -> assign-member flow end to end from
// the UI, proving the Done-when ("an analyst can create a tenant end-to-end
// ... from the UI without any manual DB inserts").
//
// Uses the existing dev-header browser session (DEV_USER_ID is already
// is_internal=true, per seed-dev-tenant.mjs) -- no dedicated fixture user
// needed, since tenant-admin-auth.ts's own gate checks app_user.is_internal
// directly, not a per-tenant membership row.
//
// AC5 (a portal session gets 403) has no reachable browser UI here (the
// client portal is a separate app, PortalApp.tsx) -- it's covered at the
// HTTP/unit level by test/unit/tenant-admin-routes.test.ts, matching that
// AC's own stated verification method ("unit: non-analyst roles rejected at
// preHandler").

let pool: pg.Pool;
const tag = `${Date.now()}`;
const tenantName = `E2E Tenant Admin ${tag}`;
const tenantSlug = `e2e-tenant-admin-${tag}`;
const domain = `tenant-admin-${tag}.test.example`;
const memberEmail = `e2e-tenant-admin-member-${tag}@example.test`;

test.beforeAll(async ({ request }) => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await assertSeeded(request, {
    check: () => request.get('/api/findings', { headers: { 'x-client-id': '11111111-1111-4111-8111-111111111111', 'x-user-id': DEV_USER_ID } }),
    errorHint: "Has 'npm run seed:dev' been run against this database?",
    validate: async (res) => res.ok(),
  });
});

test.afterAll(async () => {
  await pool.query(`DELETE FROM membership WHERE client_id IN (SELECT id FROM client WHERE slug = $1)`, [tenantSlug]);
  await pool.query(`DELETE FROM app_user WHERE email = $1`, [memberEmail]);
  await pool.query(`DELETE FROM customer_branding WHERE domain = $1`, [domain]);
  await pool.query(`DELETE FROM client WHERE slug = $1`, [tenantSlug]);
  await pool.end();
});

test('AC1-AC4: an analyst creates a tenant, configures branding, and assigns a member end to end from the UI', async ({ page }) => {
  await page.goto('/#/tenants');

  // AC1: create-tenant form -> new row appears in the list.
  await page.getByLabel('Tenant name').fill(tenantName);
  await page.getByLabel('Tenant slug').fill(tenantSlug);
  await page.getByRole('button', { name: 'Create tenant' }).click();

  const row = page.getByTestId('tenant-row').filter({ hasText: tenantName });
  await expect(row).toBeVisible();

  await row.getByRole('link', { name: tenantName }).click();
  await expect(page).toHaveURL(/\/#\/tenants\/.+/);

  // AC2: fresh tenant -> Branding tab is a CREATE form, domain editable.
  await page.getByTestId('tenant-tab-branding').click();
  await expect(page.getByLabel('Domain')).toBeEditable();

  await page.getByLabel('Domain').fill(domain);
  await page.getByLabel('Logo URL').fill('https://cdn.example.test/e2e-logo.png');
  await page.getByLabel('Primary color').fill('#112233');
  await page.getByRole('button', { name: 'Create branding' }).click();
  await expect(page.getByTestId('tenant-branding-saved')).toBeVisible();

  // AC3: reloading the tab now shows the UPDATE form (domain read-only,
  // PATCH path) -- re-navigate via Info to force a fresh detail fetch.
  await page.getByTestId('tenant-tab-info').click();
  await page.getByTestId('tenant-tab-branding').click();
  await expect(page.getByLabel('Domain')).toBeDisabled();
  await expect(page.getByLabel('Domain')).toHaveValue(domain);
  await expect(page.getByLabel('Logo URL')).toHaveValue('https://cdn.example.test/e2e-logo.png');

  await page.getByLabel('Logo URL').fill('https://cdn.example.test/e2e-logo-v2.png');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('tenant-branding-saved')).toBeVisible();

  // AC4: Members tab -- add a member by email, it appears in the roster.
  await page.getByTestId('tenant-tab-members').click();
  await expect(page.getByTestId('tenant-members-empty')).toBeVisible();

  await page.getByLabel('Member email').fill(memberEmail);
  await page.getByLabel('Member role').selectOption('client_admin');
  await page.getByRole('button', { name: 'Add member' }).click();

  const memberRow = page.getByTestId('tenant-member-row').filter({ hasText: memberEmail });
  await expect(memberRow).toBeVisible();
  await expect(memberRow).toContainText('client_admin');

  // Remove it again -- proves the DELETE path from the UI too.
  await memberRow.getByTestId('tenant-member-remove').click();
  await expect(page.getByTestId('tenant-members-empty')).toBeVisible();
});
