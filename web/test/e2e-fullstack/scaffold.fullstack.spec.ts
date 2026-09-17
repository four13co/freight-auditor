import { test, expect } from '@playwright/test';

// 86e3a6r40: the real-backend specs this testDir held (audit runs, claims,
// disputes, tenant admin, etc.) were deleted along with the components and
// API wiring they exercised, none of which the shaped UI-REBUILD subtasks
// currently restore. This placeholder proves the real Fastify server still
// serves the built frontend end to end; it is replaced by real specs as each
// feature's frontend + wiring lands.
test('scaffold root renders against the real server', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByText('Freight Auditor')).toBeVisible();
});
