import { test, expect } from '@playwright/test';

// 86e3a6r40: the real-session specs this testDir held (login, passkeys,
// profile, cross-tenant isolation, portal uploads) were deleted along with
// the auth wiring and components they exercised.
//
// 86e3a6r53: this config runs the real Fastify server + real Postgres with
// NO dev headers (its whole documented purpose -- see this config's own
// header comment), so an unauthenticated visit to "/" now genuinely
// exercises RequireAuth's real-session redirect against a real backend.
// Real login/passkey coverage returns with 86e3a6r65 (login page) once
// there's a form to submit.
test('an unauthenticated visitor is redirected to /login against the real server', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
