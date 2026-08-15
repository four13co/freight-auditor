import { defineConfig, devices } from '@playwright/test';

// Full-stack e2e (86e2uv4p0): browser -> real Fastify server -> real Postgres,
// with NO page.route mocking anywhere in this suite. This is the suite that
// would have caught PRs #51+#52's 401 break (frontend sent no auth headers,
// backend's preHandler required them, both merged green because
// dashboard.spec.ts's mocked API returns 200 regardless of what headers the
// client sends). Kept as a SEPARATE config/testDir from playwright.config.ts
// (which stays mocked, additive, fast) for two reasons: (1) dropping this spec
// into the existing testDir would make the existing `web:e2e` job try to run
// it under `vite preview`, a static file server with no API at all -- exactly
// the blind spot this item exists to close, and (2) a single `projects` array
// sharing one webServer would make plain `npm run test:e2e` require a live
// Postgres locally, which the existing mocked suite deliberately doesn't need.
//
// The webServer command here is the REAL server (`tsx src/server/index.ts`
// from the repo root), not `vite preview` -- it serves the built web/dist via
// @fastify/static (src/server/app.ts) AND the real /api/findings* endpoints
// behind the real tenant-auth preHandler. Callers must build web/, migrate,
// and seed (dev tenant + a deterministic finding fixture) BEFORE starting
// Playwright -- test:e2e:fullstack itself is just `playwright test`; the prep
// steps live in .github/workflows/ci.yml's web-fullstack job (migrate, seed:dev,
// seed:e2e-fullstack-fixture, then build web/), run that sequence locally too.
export default defineConfig({
  testDir: './test/e2e-fullstack',
  // One shared Postgres schema, no isolation between specs/workers -- mirror
  // vitest.db.config.ts's fileParallelism: false so specs don't race on the
  // same seeded rows (the item's own rabbit hole note).
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4180',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm --prefix .. run dev:fullstack-server',
    url: 'http://localhost:4180/health',
    // Never reuse whatever's already listening on this port -- unlike the
    // mocked suite's static-file server, silently reusing a stale process
    // here could mean testing against the wrong build or the wrong database,
    // which is worse than a flake: it's a suite that looks green but proves
    // nothing (the same failure class this item exists to close).
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
