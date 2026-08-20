import { defineConfig, devices } from '@playwright/test';

// Real-session full-stack e2e (86e2vqggf): browser -> real Fastify server ->
// real Postgres, with a REAL better-auth session (no DEV_AUTH_HEADERS, no
// VITE_DEV_AUTH_HEADERS) -- the one path playwright.fullstack.config.ts
// deliberately never exercises (that suite's own header comment says so
// explicitly). This is a separate config/testDir/port from BOTH
// playwright.config.ts (mocked) and playwright.fullstack.config.ts (dev-header
// stub), for the same reason those two are already kept separate: web/dist is
// one build artifact, and VITE_DEV_AUTH_HEADERS is baked in at build time
// (App.tsx's devHeaderPathActive()) -- a single dist/ cannot serve both the
// dev-header path and the real-session path at once. Running this suite
// locally right after `test:e2e:fullstack` requires rebuilding web/ in
// between (without VITE_DEV_AUTH_HEADERS) -- see the CI job for the exact
// build step this depends on.
//
// The webServer here runs on its own port (4181, vs. 4180 for the dev-header
// fullstack suite) with NO DEV_AUTH_HEADERS set, so tenant-auth.ts's
// resolveViaSession (not resolveViaDevHeaders) is what's exercised end to
// end. Prep before Playwright starts: build web/ WITHOUT VITE_DEV_AUTH_HEADERS,
// migrate, seed:dev (creates DEV_CLIENT_ID + the fixture finding's tenant),
// seed:e2e-fullstack-fixture (the finding itself), seed:e2e-auth-user (the
// real credentialed user, member of the same DEV_CLIENT_ID -- see that
// script's header for why no separate client/fixture is needed).
//
// dev:fullstack-auth-server and seed:e2e-auth-user both need SESSION_SECRET
// and APP_URL in the environment (better-auth requires both, and rejects a
// blank secret) -- deliberately NOT hardcoded into either npm script, so the
// same two env vars configure both the seed step and the server exactly
// once, from one source (the CI job's env: block; locally, export them
// yourself before running seed:e2e-auth-user or this config). APP_URL must
// match this config's baseURL exactly (scheme+host+port) -- better-auth
// gates cookie issuance/origin checks on it.
export default defineConfig({
  testDir: './test/e2e-fullstack-auth',
  // Same shared-schema reasoning as playwright.fullstack.config.ts: one
  // Postgres, no isolation between specs/workers.
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4181',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm --prefix .. run dev:fullstack-auth-server',
    url: 'http://localhost:4181/health',
    // Never reuse an existing listener -- same reasoning as the dev-header
    // fullstack config: a stale process here could be running with the wrong
    // env (e.g. DEV_AUTH_HEADERS still set from a previous run), which would
    // make this suite pass without proving anything.
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
