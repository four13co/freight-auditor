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

  /**
   * P6.A.6 (86e2zfjrj): adversarial cross-tenant probe at the real HTTP
   * layer -- a genuine second tenant, membership, and claim, then a request
   * authenticated as tenant A's own real user attempting to read tenant B's
   * resource. Distinct from the "explicit client_id predicate" describe
   * block below: that block calls listClaims/getClaimDetail directly under
   * an internal:true scope, which bypasses both RLS and the tenant-auth
   * preHandler entirely -- it proves the query-level predicate, not that
   * composing preHandler -> RLS -> route handler denies a real attacker.
   * This is the read half of the read/mutate AC; claims/recovery has no
   * mutating route (list + detail only), so there is no mutate branch to
   * probe for this family -- see portal-admin-routes.db.test.ts:199-204 for
   * the mutate-branch precedent on a route family that has a write route.
   */
  it('cross-tenant: an authenticated tenant-A user cannot list or read a tenant-B claim via the real routes', async () => {
    const owner = await pool.connect();
    let otherClientId: string;
    let otherUserId: string;
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('CRA-other', $1) RETURNING id`, [`${tag}-other`]);
      otherClientId = c.rows[0].id;
      const u = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-other@example.com`]);
      otherUserId = u.rows[0].id;
      await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'analyst')`, [otherUserId, otherClientId]);
    } finally {
      owner.release();
    }
    const otherClaimId: string = await withTenantTx({ clientIds: [otherClientId], internal: true }, async (c2) => {
      const claim = await c2.query(
        `INSERT INTO claim (client_id, amount_claimed, currency, status) VALUES ($1, '900.0000', 'USD', 'open') RETURNING id`,
        [otherClientId],
      );
      return claim.rows[0].id;
    });

    // clientId/userId (this describe block's own tenant A) request tenant
    // B's real claim id -- with tenant A's own valid header pair, not
    // otherClientId's.
    const listRes = await app.inject({
      method: 'GET', url: '/api/claims', headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().claims.some((c: { id: string }) => c.id === otherClaimId)).toBe(false);

    const detailRes = await app.inject({
      method: 'GET', url: `/api/claims/${otherClaimId}`, headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    // 404, not 403: the route must not confirm the resource exists under a
    // clientId the caller cannot see -- same non-leaking shape as
    // portal-admin-routes.db.test.ts's own cross-tenant PATCH probe.
    expect(detailRes.statusCode).toBe(404);

    const cleanup = await pool.connect();
    try {
      await cleanup.query(`DELETE FROM claim WHERE id = $1`, [otherClaimId]);
      await cleanup.query(`DELETE FROM membership WHERE user_id = $1`, [otherUserId]);
      await cleanup.query(`DELETE FROM app_user WHERE id = $1`, [otherUserId]);
      await cleanup.query(`DELETE FROM client WHERE id = $1`, [otherClientId]);
    } finally {
      cleanup.release();
    }
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

/**
 * P6.C.1: listClaims' keyset-cursor pagination against real Postgres --
 * total ordering under a same-opened_at tie (the exact case the id
 * tiebreaker was added to fix), and that a cursor never overrides the
 * explicit clientId predicate to cross a tenant boundary.
 */
describe('listClaims: keyset cursor pagination (DB, P6.C.1)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let clientBId: string;
  let claimIds: string[];
  const tag = `lcp-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('LCP-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const b = await owner.query(`INSERT INTO client (name, slug) VALUES ('LCP-B', $1) RETURNING id`, [`${tag}-b`]);
      clientBId = b.rows[0].id;

      await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
        // r1/r2 share the exact same opened_at -- the tie the id tiebreaker
        // (ORDER BY opened_at DESC, id ASC) exists to resolve; without it,
        // keyset pagination could drop or duplicate one of these two across
        // a page boundary.
        const tie = '2026-01-01T00:00:00Z';
        const r1 = await c.query(
          `INSERT INTO claim (client_id, amount_claimed, currency, status, opened_at) VALUES ($1, '100.0000', 'USD', 'open', $2) RETURNING id`,
          [clientAId, tie],
        );
        const r2 = await c.query(
          `INSERT INTO claim (client_id, amount_claimed, currency, status, opened_at) VALUES ($1, '200.0000', 'USD', 'open', $2) RETURNING id`,
          [clientAId, tie],
        );
        const r3 = await c.query(
          `INSERT INTO claim (client_id, amount_claimed, currency, status, opened_at) VALUES ($1, '300.0000', 'USD', 'open', '2026-01-02T00:00:00Z') RETURNING id`,
          [clientAId],
        );
        claimIds = [r1.rows[0].id, r2.rows[0].id, r3.rows[0].id];
      });

      await withTenantTx({ clientIds: [clientBId], internal: true }, (c) =>
        c.query(`INSERT INTO claim (client_id, amount_claimed, currency, status) VALUES ($1, '999.0000', 'USD', 'open')`, [clientBId]),
      );
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM claim WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM client WHERE id IN ($1, $2)`, [clientAId, clientBId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('pages through all rows with limit=1, one row at a time, with no drops or duplicates across a same-opened_at tie', async () => {
    const seen: string[] = [];
    let cursor: { id: string } | undefined;
    for (let i = 0; i < claimIds.length + 1; i++) {
      const rows = await withTenantTx({ clientIds: [clientAId], internal: true }, (c) =>
        listClaims(c, clientAId, { limit: 1, cursor }),
      );
      if (rows.length === 0) break;
      seen.push(rows[0]!.id);
      cursor = { id: rows[0]!.id };
    }
    expect(seen.sort()).toEqual([...claimIds].sort());
  });

  it('a cursor minted from client A rows never lets a client B query see a client A row', async () => {
    const aRows = await withTenantTx({ clientIds: [clientAId], internal: true }, (c) => listClaims(c, clientAId, { limit: 10 }));
    const lastA = aRows[aRows.length - 1]!;

    // The cursor's anchor lookup is itself gated by the explicit client_id
    // predicate (client_id = clientBId), so a client-A id can never resolve
    // as an anchor here -- the whole query comes back empty, not a leak.
    const bRows = await withTenantTx({ clientIds: [clientBId], internal: false }, (c) =>
      listClaims(c, clientBId, { limit: 10, cursor: { id: lastA.id } }),
    );
    expect(bRows.some((r) => claimIds.includes(r.id))).toBe(false);
  });
});
