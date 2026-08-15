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
 */
describe('Dashboard auth headers accepted end-to-end (DB)', () => {
  let app: FastifyInstance;

  const DASHBOARD_HEADERS = {
    'x-client-id': DEV_CLIENT_ID,
    'x-user-id': DEV_USER_ID,
  };

  beforeAll(async () => {
    await seedDevTenant({ pool: getPool() });
    app = buildApp();
  });

  afterAll(async () => {
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
