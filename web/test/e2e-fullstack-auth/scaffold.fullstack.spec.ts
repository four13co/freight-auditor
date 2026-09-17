import { test, expect } from '@playwright/test';

// 86e3a6r40: the real-session specs this testDir held (login, passkeys,
// profile, cross-tenant isolation, portal uploads) were deleted along with the
// auth wiring and components they exercised. Real-session coverage for login
// and passkeys returns with 86e3a6r53 (auth context + route guards) and
// 86e3a6r65 (login page); this placeholder only proves the real server still
// serves the built frontend end to end.
test('scaffold root renders against the real server', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByText('Freight Auditor')).toBeVisible();
});
