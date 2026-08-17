import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../../src/db/pool.js';
import { buildApp } from '../../src/server/app.js';
import { seedDevTenant, DEV_CLIENT_ID, DEV_USER_ID } from '../../scripts/seed-dev-tenant.mjs';

/**
 * 86e2urebj: proves the actual fix end-to-end at the HTTP layer -- the exact
 * headers web/src/lib/api.ts's authHeaders() sends, against the real
 * preHandler + a real (seeded) membership row. This is the check that was
 * skipped originally: the header-presence fix alone still 401s without
 * scripts/seed-dev-tenant.mjs, because tenant-auth.ts's membership check
 * requires a REAL row, not just both headers being non-empty.
 *
 * web/'s own unit test (test/api.test.tsx) proves the headers are SENT;
 * this proves the values they're set to are ACCEPTED. Together they cover
 * the full regression this item exists to close.
 *
 * 86e2v1bbr gated this path behind DEV_AUTH_HEADERS (unset = a verified
 * better-auth session is required instead, see tenant-auth-session.db.test.ts)
 * -- this suite sets the flag for its own lifetime so it keeps proving
 * exactly what it always proved: the dev-header path, unchanged, when the
 * flag is explicitly on (the dashboard's real deployed/CI configuration).
 */
describe('Dashboard auth headers accepted end-to-end (DB)', () => {
  let app: FastifyInstance;
  let originalFlag: string | undefined;

  const DASHBOARD_HEADERS = {
    'x-client-id': DEV_CLIENT_ID,
    'x-user-id': DEV_USER_ID,
  };

  beforeAll(async () => {
    originalFlag = process.env.DEV_AUTH_HEADERS;
    process.env.DEV_AUTH_HEADERS = '1';
    await seedDevTenant({ pool: getPool() });
    app = buildApp();
  });

  afterAll(async () => {
    if (originalFlag === undefined) delete process.env.DEV_AUTH_HEADERS;
    else process.env.DEV_AUTH_HEADERS = originalFlag;
    await app.close();
    await closePool();
  });

  it('GET /api/findings with the dashboard\'s dev-mode headers returns 200, not 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/findings', headers: DASHBOARD_HEADERS });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('findings');
  });

  it('GET /api/findings/summary with the dashboard\'s dev-mode headers returns 200, not 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/findings/summary', headers: DASHBOARD_HEADERS });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('recoverableOpen');
  });

  it('the preHandler\'s 401 behavior is unchanged for a request missing both headers (86e2u7j2y AC3, still enforced)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/findings' });
    expect(res.statusCode).toBe(401);
  });
});
