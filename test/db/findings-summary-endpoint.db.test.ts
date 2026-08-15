import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { buildApp } from '../../src/server/app.js';

/**
 * 86e2u7j0j AC1-2, exercised at the HTTP layer (GET /api/findings/summary).
 *
 * AC2's original contract ("no x-client-id -> 200 with zeros") is superseded
 * by 86e2u7j2y AC3 ("missing header(s) -> 401") -- membership validation now
 * gates these routes, so an unscoped/unauthenticated request is rejected
 * outright rather than silently scoped to nothing. Updated in place per that
 * item landing, not left asserting a contract this endpoint no longer has.
 */
describe('GET /api/findings/summary (DB, e2e)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let clientId: string;
  let userId: string;
  const tag = `fse-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('FSE', $1) RETURNING id`, [tag]);
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
           VALUES ($1, $2, $3, 'OVERCHARGE', '250.0000', 'USD', 'open')`,
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

  it('AC1: returns the four aggregate numbers for the client+user in the request headers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/findings/summary',
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ recoverableOpen: '250.0000', flaggedToday: 1, withCarriers: 0 });
  });

  it('AC2 (superseded by 86e2u7j2y AC3): a request with no x-client-id header is rejected, not silently scoped to zero', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/findings/summary' });
    expect(res.statusCode).toBe(401);
  });
});
