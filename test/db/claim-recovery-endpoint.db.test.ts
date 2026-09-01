import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { buildApp } from '../../src/server/app.js';
import { listClaims } from '../../src/modules/claims/list-claims.js';
import { getClaimDetail } from '../../src/modules/claims/get-claim-detail.js';

/**
 * P5.B.4: GET /api/claims and GET /api/claims/:id, exercised at the HTTP
 * layer. Uses the dev-header identity source (DEV_AUTH_HEADERS=1), same
 * pattern as findings-endpoint.db.test.ts.
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

/**
 * Direct module coverage of the explicit client_id predicate on
 * listClaims/getClaimDetail, independent of RLS -- same shape as #216's
 * (86e31a9ch) clarification-answers.db.test.ts additions. An internal
 * (cross-client) analyst scope grants RLS-level visibility across every
 * client, so if the only thing stopping a cross-tenant read were RLS, an
 * `internal: true` caller passing the WRONG clientId would still see this
 * claim. These tests prove the explicit predicate -- not RLS -- is what
 * rejects it.
 */
describe('claim + recovery query modules: explicit client_id predicate (DB)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let claimId: string;
  const tag = `crp-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('CRP-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
        const claim = await c.query(
          `INSERT INTO claim (client_id, amount_claimed, currency, status) VALUES ($1, '500.0000', 'USD', 'open') RETURNING id`,
          [clientAId],
        );
        claimId = claim.rows[0].id;
        await c.query(`INSERT INTO recovery_event (client_id, claim_id, amount_recovered, currency) VALUES ($1, $2, '200.0000', 'USD')`, [clientAId, claimId]);
      });
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM recovery_event WHERE client_id = $1`, [clientAId]);
      await owner.query(`DELETE FROM claim WHERE client_id = $1`, [clientAId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientAId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  const otherClientId = '00000000-0000-4000-8000-000000000099';

  it('the explicit predicate rejects a mismatched clientId on listClaims, even under an internal (cross-client) RLS scope', async () => {
    const rows = await withTenantTx({ internal: true }, (c) => listClaims(c, otherClientId));
    expect(rows.some((r) => r.id === claimId)).toBe(false);
  });

  it('the explicit predicate rejects a mismatched clientId on getClaimDetail, even under an internal (cross-client) RLS scope', async () => {
    const detail = await withTenantTx({ internal: true }, (c) => getClaimDetail(c, otherClientId, claimId));
    expect(detail).toBeNull();
  });

  it('the explicit predicate still finds the row under an internal scope when the clientId matches', async () => {
    const rows = await withTenantTx({ internal: true }, (c) => listClaims(c, clientAId));
    expect(rows.some((r) => r.id === claimId)).toBe(true);

    const detail = await withTenantTx({ internal: true }, (c) => getClaimDetail(c, clientAId, claimId));
    expect(detail?.id).toBe(claimId);
    expect(detail?.cumulativeRecovered).toBe('200.0000');
  });
});
