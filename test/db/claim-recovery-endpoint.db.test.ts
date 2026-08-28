import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { buildApp } from '../../src/server/app.js';

/**
 * P5.B.4: GET /api/claims and GET /api/claims/:id, exercised at the HTTP
 * layer. Uses the dev-header identity source (DEV_AUTH_HEADERS=1), same
 * pattern as findings-endpoint.db.test.ts.
 *
 * REQUIRES #178 merged: claim.aging_deadline_at does not exist on this
 * branch's Development base yet -- this suite cannot run until that PR
 * lands, in addition to the usual no-local-Postgres constraint.
 */
describe('claim + recovery APIs (DB, e2e)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let clientId: string;
  let userId: string;
  let claimId: string;
  let originalFlag: string | undefined;
  const tag = `cra-${Date.now()}`;

  beforeAll(async () => {
    originalFlag = process.env.DEV_AUTH_HEADERS;
    process.env.DEV_AUTH_HEADERS = '1';
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('CRA', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const u = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}@example.com`]);
      userId = u.rows[0].id;
      await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'analyst')`, [userId, clientId]);
      await withTenantTx({ clientIds: [clientId], internal: true }, async (c2) => {
        const claim = await c2.query(
          `INSERT INTO claim (client_id, amount_claimed, currency, status) VALUES ($1, '500.0000', 'USD', 'open') RETURNING id`,
          [clientId],
        );
        claimId = claim.rows[0].id;
        await c2.query(`INSERT INTO recovery_event (client_id, claim_id, amount_recovered, currency) VALUES ($1, $2, '200.0000', 'USD')`, [clientId, claimId]);
      });
    } finally {
      owner.release();
    }
    app = buildApp();
  });

  afterAll(async () => {
    process.env.DEV_AUTH_HEADERS = originalFlag;
    await app.close();
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM recovery_event WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM claim WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM membership WHERE user_id = $1`, [userId]);
      await owner.query(`DELETE FROM app_user WHERE id = $1`, [userId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('lists claims for the caller tenant', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/claims', headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.claims.some((c: { id: string }) => c.id === claimId)).toBe(true);
  });

  it('returns claim detail with its recovery event history and cumulative total', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/claims/${claimId}`, headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(claimId);
    expect(body.recoveryEvents).toHaveLength(1);
    expect(body.cumulativeRecovered).toBe('200.0000');
  });

  it('rejects an invalid claim id', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/claims/not-a-uuid', headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for an unknown claim id', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/claims/00000000-0000-0000-0000-000000000000', headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an unauthenticated list request', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/claims' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an out-of-range limit', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/claims?limit=9999', headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(res.statusCode).toBe(400);
  });
});
