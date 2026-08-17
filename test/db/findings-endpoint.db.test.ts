import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { buildApp } from '../../src/server/app.js';

/**
 * 86e2u7j0d AC1-3, exercised at the HTTP layer (GET /api/findings).
 *
 * AC2's original contract ("no x-client-id -> 200, empty tenant scope") is
 * superseded by 86e2u7j2y AC3 ("missing header(s) -> 401") -- membership
 * validation now gates this route, so an unscoped/unauthenticated request is
 * rejected outright rather than silently scoped to nothing. Updated in place
 * per that item landing, not left asserting a contract this endpoint no
 * longer has.
 */
describe('GET /api/findings (DB, e2e)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let clientId: string;
  let userId: string;
  const tag = `fe-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('FE', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const u = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}@example.com`]);
      userId = u.rows[0].id;
      await owner.query(
        `INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_viewer')`,
        [userId, clientId],
      );
      const carrier = await owner.query(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [`Carrier-${tag}`]);
      await withTenantTx({ clientIds: [clientId], internal: true }, async (c2) => {
        const inv = await c2.query(
          `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version)
           VALUES ($1, $2, '210', $3, 'USD', 'test') RETURNING id`,
          [clientId, carrier.rows[0].id, `INV-${tag}`],
        );
        const run = await c2.query(
          `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'test', 'SCORED') RETURNING id`,
          [clientId, inv.rows[0].id],
        );
        const cf = await c2.query(
          `INSERT INTO charge_fact (client_id, invoice_id, code, category, amount, currency) VALUES ($1, $2, '400', 'LINEHAUL', '1000.0000', 'USD') RETURNING id`,
          [clientId, inv.rows[0].id],
        );
        await c2.query(
          `INSERT INTO variance_finding (client_id, audit_run_id, charge_fact_id, direction, variance_amount, currency, status)
           VALUES ($1, $2, $3, 'OVERCHARGE', '100.0000', 'USD', 'open')`,
          [clientId, run.rows[0].id, cf.rows[0].id],
        );
      });
    } finally {
      owner.release();
    }
    app = buildApp();
  });

  afterAll(async () => {
    await app.close();
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM variance_finding WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM charge_fact WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM audit_run WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM invoice WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM carrier WHERE name = $1`, [`Carrier-${tag}`]);
      await owner.query(`DELETE FROM membership WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM app_user WHERE id = $1`, [userId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('AC1: returns seeded rows for the client+user in the request headers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/findings',
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]).toMatchObject({ carrierName: `Carrier-${tag}`, billed: '1000.0000', status: 'open' });
  });

  it('AC2 (superseded by 86e2u7j2y AC3): a request with no x-client-id header is rejected, not silently scoped to zero', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/findings' });
    expect(res.statusCode).toBe(401);
  });

  it('AC3: status query param filters results', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/findings?status=closed',
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().findings).toHaveLength(0);
  });

  /**
   * Review finding: app.ts read `query.minAmount` (camelCase) but the item's
   * own AC names the param `min-amount` (kebab-case), and Fastify returns
   * querystring keys literally as sent -- so the filter was silently dead for
   * every real caller. These exercise the actual URL string, not a JS object,
   * so a regression back to reading the wrong key fails loudly here.
   */
  it('AC3: min-amount query param excludes findings below the threshold', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/findings?min-amount=150',
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().findings).toHaveLength(0); // seeded finding's variance_amount is 100.0000
  });

  it('AC3: min-amount query param includes findings at or above the threshold', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/findings?min-amount=100',
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().findings).toHaveLength(1);
  });

  /**
   * 86e2v24ye: status/min-amount were interpolated into the query with no
   * validation -- a malformed value threw a raw Postgres error, reflected
   * into the response by Fastify's default handler. e2e against the real
   * route + real DB, proving the bad value never reaches Postgres at all.
   */
  it('86e2v24ye: an invalid status query param returns 400 with a clean message, not a raw Postgres error', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/findings?status=not-a-real-status',
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body).toHaveProperty('error');
    expect(JSON.stringify(body)).not.toMatch(/invalid input value for enum|variance_status/i);
  });

  it('86e2v24ye: a non-numeric min-amount query param returns 400, not a 500 with PG error detail', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/findings?min-amount=not-a-number',
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body).toHaveProperty('error');
    expect(JSON.stringify(body)).not.toMatch(/invalid input syntax for type numeric/i);
  });
});
