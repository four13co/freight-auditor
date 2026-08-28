import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { buildApp } from '../../src/server/app.js';

/**
 * P5.A.1: POST /api/disputes/:id/claim, exercised at the HTTP layer. Uses
 * the dev-header identity source (DEV_AUTH_HEADERS=1), same pattern as
 * payment-authorization-endpoint.db.test.ts.
 */
describe('POST /api/disputes/:id/claim (DB, e2e)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let clientId: string;
  let userId: string;
  let acceptedDisputeId: string;
  let sentDisputeId: string;
  let originalFlag: string | undefined;
  const tag = `claim-${Date.now()}`;

  beforeAll(async () => {
    originalFlag = process.env.DEV_AUTH_HEADERS;
    process.env.DEV_AUTH_HEADERS = '1';
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('CLAIM', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const u = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}@example.com`]);
      userId = u.rows[0].id;
      await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'analyst')`, [userId, clientId]);
      await withTenantTx({ clientIds: [clientId], internal: true }, async (c2) => {
        const accepted = await c2.query(
          `INSERT INTO dispute (client_id, status, amount_claimed, currency) VALUES ($1, 'accepted', '400.0000', 'USD') RETURNING id`,
          [clientId],
        );
        acceptedDisputeId = accepted.rows[0].id;
        const sent = await c2.query(
          `INSERT INTO dispute (client_id, status, amount_claimed, currency) VALUES ($1, 'sent', '100.0000', 'USD') RETURNING id`,
          [clientId],
        );
        sentDisputeId = sent.rows[0].id;
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
      await owner.query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM claim WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM dispute WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM membership WHERE user_id = $1`, [userId]);
      await owner.query(`DELETE FROM app_user WHERE id = $1`, [userId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('opens a claim against an accepted dispute and is idempotent on retry', async () => {
    const first = await app.inject({
      method: 'POST',
      url: `/api/disputes/${acceptedDisputeId}/claim`,
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json();
    expect(firstBody).toMatchObject({ disputeId: acceptedDisputeId, amountClaimed: '400.0000', currency: 'USD' });

    const retry = await app.inject({
      method: 'POST',
      url: `/api/disputes/${acceptedDisputeId}/claim`,
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(firstBody);

    const owner = await pool.connect();
    try {
      const rows = await owner.query(`SELECT count(*)::int AS n FROM claim WHERE dispute_id = $1`, [acceptedDisputeId]);
      expect(rows.rows[0].n).toBe(1);
    } finally {
      owner.release();
    }
  });

  it('rejects a dispute that is not accepted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/disputes/${sentDisputeId}/claim`,
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/disputes/${acceptedDisputeId}/claim`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 for an unknown dispute id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/disputes/00000000-0000-0000-0000-000000000000/claim`,
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(res.statusCode).toBe(404);
  });
});
