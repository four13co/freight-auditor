import { test, expect } from '@playwright/test';

// 86e3a6r40: the pre-rebuild dashboard/portal specs this testDir held were
// deleted along with the components they exercised. This placeholder proves
// the new Vite build serves correctly under `vite preview`; it is replaced by
// real mocked-API specs as each screen-building subtask lands.
test('scaffold root renders', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByText('Freight Auditor')).toBeVisible();
});
