import { test, expect } from '@playwright/test';
import type { CDPSession, BrowserContext, Page } from '@playwright/test';

// 86e2v1bf1: proves the real passkey register -> sign-in round trip end to
// end, reusing the real-session (no DEV_AUTH_HEADERS) harness from 86e2vqggf
// -- no new Playwright config/port/CI job needed, since @better-auth/passkey
// rides the existing /api/auth/* mount this stack already exercises. A
// virtual WebAuthn authenticator (Chrome DevTools Protocol) is required --
// there is no way to drive a real passkey ceremony (platform authenticator
// UI, biometric prompt) from a scripted test -- per the shape's own Rabbit
// hole, confirmed working here rather than assumed.
//
// A fresh, separate account is used (not seed-e2e-auth-user.mjs's shared
// e2e-real-session@example.com) so registering a passkey on it can't affect
// real-session.fullstack.spec.ts's own use of that shared account -- signing
// up in-test via the same real login form's underlying endpoint, since
// nothing in this repo seeds a dedicated passkey-test user.
const PASSKEY_TEST_EMAIL = `passkey-e2e-${Date.now()}@example.com`;
const PASSKEY_TEST_PASSWORD = 'passkey-e2e-test-password-86e2v1bf1';

async function addVirtualAuthenticator(context: BrowserContext, page: Page): Promise<CDPSession> {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return cdp;
}

test.beforeAll(async ({ request }) => {
  // Own account, created fresh here rather than reusing the shared e2e seed
  // user -- fail loudly if sign-up itself is broken, before any WebAuthn
  // ceremony is attempted (a failure there would otherwise look identical
  // to a virtual-authenticator problem).
  const res = await request.post('/api/auth/sign-up/email', {
    data: { email: PASSKEY_TEST_EMAIL, password: PASSKEY_TEST_PASSWORD, name: 'Passkey E2E Test' },
  });
  if (!res.ok()) {
    throw new Error(`Passkey e2e setup check failed: POST /api/auth/sign-up/email returned ${res.status()}.`);
  }

  // 86e2wb92b: a real session alone proves WHO, not WHICH client -- App.tsx
  // waits on GET /api/auth/memberships resolving a client_id before ever
  // rendering the dashboard, and that lookup returns empty (dashboard stuck
  // on the login form indefinitely, not a clear error) without a membership
  // row. seed-e2e-auth-user.mjs gives its shared user one against
  // DEV_CLIENT_ID; this fresh sign-up needs the same, done directly against
  // the DB here since there's no HTTP endpoint that grants membership.
  const { withTenantTx } = await import('../../../src/db/tenant-context.js');
  const { DEV_CLIENT_ID } = await import('../../../scripts/seed-dev-tenant.mjs');
  await withTenantTx({ internal: true }, async (client) => {
    await client.query(
      `INSERT INTO membership (user_id, client_id, role)
       SELECT id, $2, 'client_admin' FROM app_user WHERE email = $1
       ON CONFLICT (user_id, client_id) DO NOTHING`,
      [PASSKEY_TEST_EMAIL, DEV_CLIENT_ID],
    );
  });
});

test('AC1/AC2: register a passkey while logged in, then sign in using ONLY the passkey (session cleared, same authenticator)', async ({
  context,
  page,
}) => {
  // A virtual authenticator is a per-context CDP object -- credentials
  // registered on one context's authenticator are NOT visible to a
  // different context's authenticator (confirmed empirically: a second
  // browser.newContext() with its own fresh authenticator produced "Auth
  // cancelled" on sign-in, since it held no discoverable credential at all).
  // Keeping ONE context/authenticator and clearing the session in between
  // is what actually isolates "does the passkey alone work" -- session
  // cookie + sessionStorage are both cleared before the sign-in half, so
  // resolveViaSession (tenant-auth.ts) has nothing to fall back to and
  // success can only come from the WebAuthn credential.
  await addVirtualAuthenticator(context, page);

  // Registration happens in an authenticated context (signed in via
  // email/password first, matching the shape's "register a passkey option
  // once logged in" solution).
  await page.goto('/');
  await page.getByLabel('Email').fill(PASSKEY_TEST_EMAIL);
  await page.getByLabel('Password').fill(PASSKEY_TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByTestId('kpi-row')).toBeVisible();

  await page.getByRole('button', { name: 'Register a passkey' }).click();
  await expect(page.getByText('Passkey registered.')).toBeVisible();

  // Clear the session (cookie + the client_id sessionStorage entry
  // 86e2wb92b's fetchAndStoreClientId() populated) so the next login can
  // only succeed via the passkey credential, not a leftover session.
  await context.clearCookies();
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();

  const row = page.getByTestId('finding-row');
  await expect(row.first()).toBeVisible();
  await expect(page.getByTestId('kpi-row')).toBeVisible();
});

test('AC3: email/password sign-in remains fully functional (no regression from adding passkey support)', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Email').fill(PASSKEY_TEST_EMAIL);
  await page.getByLabel('Password').fill(PASSKEY_TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await expect(page.getByTestId('kpi-row')).toBeVisible();
});
