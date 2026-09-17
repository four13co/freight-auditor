import { test, expect } from '@playwright/test';

// 86e3a6r40: the pre-rebuild dashboard/portal specs this testDir held were
// deleted along with the components they exercised, replaced by this
// placeholder proving `vite preview` served the scaffold correctly.
//
// 86e3a6r53: this preview server has no backend at all (`vite preview` is a
// static file server, and this config's build has no VITE_DEV_AUTH_HEADERS),
// so an unauthenticated visit to "/" now genuinely redirects to /login --
// this is real route-guard behavior, not a placeholder assumption.
test('an unauthenticated visitor is redirected to /login', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
