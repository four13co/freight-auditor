import { test, expect } from '@playwright/test';

// 86e3a7d57: proves the admin Users page's ">100 tenants, no silent drop"
// AC against the real server + real Postgres (the DB-level AC4 test in
// test/db/tenant-admin-queries.db.test.ts could only approximate this --
// it proves listAllTenantMembers' keyset pagination is correct for a
// couple of rows, not that fetchAllUsers() actually surfaces a tenant past
// the OLD fan-out's hardcoded limit=100 tenant cap).
//
// MANY_TENANTS_COUNT and the email pattern below must match
// scripts/seed-e2e-many-members.mjs's own MANY_TENANTS_COUNT /
// manyTenantMemberEmail() exactly. Run (after seed:dev):
//   npm run seed:e2e-many-members
// before this suite -- see that script's own header for why 105 specifically
// (it must exceed the old fetchTenantSummaries() limit=100 cap for this
// spec to have failed against the pre-86e3a7d57 fan-out).
//
// The old cap's GET /api/internal/tenants query orders by
// client.created_at DESC (list-clients.ts), i.e. MOST RECENT first -- so the
// tenant the old fan-out would have silently dropped is the OLDEST one past
// the cap, not the newest. This suite's fresh DB has exactly
// DEV_CLIENT_ID (oldest) + e2e-many-tenant-1..105 (created in that order,
// so tenant-1 is the second-oldest overall): with limit=100, the 100 most
// recent are tenant-105 down through tenant-6, leaving DEV_CLIENT_ID and
// tenant-1..5 (6 tenants) excluded. tenant-1's member is therefore
// guaranteed to have been dropped by the old fan-out and is what this test
// asserts on -- tenant-105's member would have appeared even under the old
// cap and would prove nothing.
const OLD_CAP_EXCLUDED_TENANT_MEMBER_EMAIL = 'e2e-many-user-1@example.test';

test('admin Users page represents a tenant past the old 100-tenant fan-out cap', async ({ page }) => {
  // Navigate via the sidebar link, not a direct page.goto('/employee/users')
  // deep link -- this repo's static file server (static-routes.ts) serves
  // web/dist with no SPA catch-all route, so a hard navigation straight to a
  // client-side route 404s server-side; going through the app's own router
  // from '/' is both the realistic user flow and the only one this server
  // supports today.
  await page.goto('/');
  await page.getByRole('link', { name: 'Users', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();

  // This search runs over the full aggregated fetchAllUsers() result
  // (DataTable's own client-side pageSize only limits what's rendered per
  // page, not what's searchable) -- see the module comment above for why
  // this specific tenant proves the old cap would have dropped it.
  await page.getByLabel('Search by name or email…').fill(OLD_CAP_EXCLUDED_TENANT_MEMBER_EMAIL);
  await expect(page.getByText(OLD_CAP_EXCLUDED_TENANT_MEMBER_EMAIL)).toBeVisible();
});

// A different seeded member than the no-drop test above, so the two tests
// stay independent of each other's edits.
const EDIT_TARGET_MEMBER_EMAIL = 'e2e-many-user-2@example.test';

test('admin can edit a member role and toggle enable/disable via the real PATCH endpoint', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Users', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
  await page.getByLabel('Search by name or email…').fill(EDIT_TARGET_MEMBER_EMAIL);

  // Reads the row's OWN starting role/status rather than assuming the
  // freshly-seeded 'client_viewer'/active baseline -- the seed script
  // (scripts/seed-e2e-many-members.mjs) is idempotent and only seeds once,
  // so a re-run of this spec against a not-torn-down local DB starts from
  // whatever the previous run last left the row in. Both PATCH paths are
  // proved as a round trip back to whatever that starting state was, so the
  // suite stays safe to re-run indefinitely.
  const row = page.locator('tr', { hasText: EDIT_TARGET_MEMBER_EMAIL });
  await expect(row).toBeVisible();
  const toggle = row.getByRole('button', { name: /^(Disable|Enable)$/ });
  const startingRoleLabel = (await row.locator('td').nth(2).textContent())!.trim();
  const startingToggleLabel = (await toggle.textContent())!.trim();
  const otherRole = startingRoleLabel === 'Client (Admin)' ? 'client_viewer' : 'client_admin';
  const otherRoleLabel = otherRole === 'client_viewer' ? 'Client (Viewer)' : 'Client (Admin)';

  await row.getByRole('button', { name: 'Edit role' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit role' });
  await dialog.getByLabel('Role').selectOption(otherRole);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(row.getByText(otherRoleLabel)).toBeVisible();

  await toggle.click();
  await expect(toggle).toHaveText(startingToggleLabel === 'Disable' ? 'Enable' : 'Disable');

  // Round-trip both fields back to their starting values.
  await row.getByRole('button', { name: 'Edit role' }).click();
  await dialog.getByLabel('Role').selectOption(startingRoleLabel === 'Client (Admin)' ? 'client_admin' : 'client_viewer');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(row.getByText(startingRoleLabel)).toBeVisible();

  await toggle.click();
  await expect(toggle).toHaveText(startingToggleLabel);
});
