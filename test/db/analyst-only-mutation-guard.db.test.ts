import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../../src/db/pool.js';
import { buildApp } from '../../src/server/app.js';

/**
 * 86e367qxx, against real Postgres: proves the previously-exploitable path
 * fails closed end-to-end -- the real dev-header resolver
 * (resolveAuthorizedTenantContext, tenant-auth.ts) resolving a REAL
 * client_viewer/client_admin membership row, through the real
 * registerAnalystOnlyPreHandler, on the real routes. Unit coverage
 * (dispute-review-routes.test.ts, findings-reverse-endpoint.test.ts) only
 * proves the guard reads request.actorRole correctly -- it mocks
 * tenant-auth.ts entirely, so it can't prove the role a real membership row
 * resolves to is actually gated. This is that proof.
 *
 * A nonexistent dispute/finding id is used deliberately: the guard runs as
 * a preHandler, before the route body's own DB lookups, so a client_viewer
 * gets 403 without ever reaching those lookups, while an analyst passes the
 * guard and reaches the route body, which then reports 409/404 for the
 * fabricated id -- proving the guard discriminated on the real resolved
 * role, not on the id being valid.
 */
describe('registerAnalystOnlyPreHandler (DB): dispute + finding mutation routes', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let clientId: string;
  let viewerUserId: string;
  let adminUserId: string;
  let analystUserId: string;
  let originalFlag: string | undefined;
  const tag = `aomg-${Date.now()}`;
  const FAKE_ID = '99999999-9999-4999-8999-999999999999';

  beforeAll(async () => {
    originalFlag = process.env.DEV_AUTH_HEADERS;
    process.env.DEV_AUTH_HEADERS = '1';
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('AOMG', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;

      const uViewer = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-viewer@example.com`]);
      viewerUserId = uViewer.rows[0].id;
      const uAdmin = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-admin@example.com`]);
      adminUserId = uAdmin.rows[0].id;
      const uAnalyst = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-analyst@example.com`]);
      analystUserId = uAnalyst.rows[0].id;

      await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_viewer')`, [viewerUserId, clientId]);
      await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_admin')`, [adminUserId, clientId]);
      await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'analyst')`, [analystUserId, clientId]);
    } finally {
      owner.release();
    }
    app = buildApp();
  });

  afterAll(async () => {
    if (originalFlag === undefined) delete process.env.DEV_AUTH_HEADERS;
    else process.env.DEV_AUTH_HEADERS = originalFlag;
    await app.close();
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM membership WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM app_user WHERE id = ANY($1)`, [[viewerUserId, adminUserId, analystUserId]]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  function headersFor(userId: string) {
    return { 'x-client-id': clientId, 'x-user-id': userId };
  }

  it('AC1: a client_viewer is rejected with 403 on POST /api/disputes/:id/accept', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/disputes/${FAKE_ID}/accept`, headers: headersFor(viewerUserId), payload: {} });
    expect(res.statusCode).toBe(403);
  });

  it('AC1: a client_admin is rejected with 403 on POST /api/disputes/:id/close', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/disputes/${FAKE_ID}/close`, headers: headersFor(adminUserId), payload: {} });
    expect(res.statusCode).toBe(403);
  });

  it('AC1: a client_viewer is rejected with 403 on POST /api/findings/:id/reverse', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/findings/${FAKE_ID}/reverse`, headers: headersFor(viewerUserId),
      payload: { caseFingerprint: 'x', assertedValue: 1 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('AC2: an analyst still reaches the route body (409, not 403) on POST /api/disputes/:id/accept', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/disputes/${FAKE_ID}/accept`, headers: headersFor(analystUserId), payload: {} });
    expect(res.statusCode).toBe(409);
  });

  it('AC2: an analyst still reaches the route body (404, not 403) on POST /api/findings/:id/reverse', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/findings/${FAKE_ID}/reverse`, headers: headersFor(analystUserId),
      payload: { caseFingerprint: 'x', assertedValue: 1 },
    });
    expect(res.statusCode).toBe(404);
  });
});
