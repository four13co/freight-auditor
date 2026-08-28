import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { buildApp } from '../../src/server/app.js';

/**
 * P4.B.5: POST /api/audit-runs/:id/payment-authorization, exercised at the
 * HTTP layer. Uses the dev-header identity source (DEV_AUTH_HEADERS=1),
 * same pattern as findings-endpoint.db.test.ts.
 */
describe('POST /api/audit-runs/:id/payment-authorization (DB, e2e)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let clientId: string;
  let userId: string;
  let auditRunId: string;
  let originalFlag: string | undefined;
  const tag = `pa-${Date.now()}`;

  beforeAll(async () => {
    originalFlag = process.env.DEV_AUTH_HEADERS;
    process.env.DEV_AUTH_HEADERS = '1';
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('PA', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const u = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}@example.com`]);
      userId = u.rows[0].id;
      await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'analyst')`, [userId, clientId]);
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
        auditRunId = run.rows[0].id;
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
      await owner.query(`DELETE FROM payment_gate_decision WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM audit_run WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM invoice WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM membership WHERE user_id = $1`, [userId]);
      await owner.query(`DELETE FROM app_user WHERE id = $1`, [userId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('records an analyst approve decision and is idempotent on retry', async () => {
    const first = await app.inject({
      method: 'POST',
      url: `/api/audit-runs/${auditRunId}/payment-authorization`,
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
      payload: { action: 'approve' },
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json();
    expect(firstBody).toMatchObject({ auditRunId, action: 'approve' });

    const retry = await app.inject({
      method: 'POST',
      url: `/api/audit-runs/${auditRunId}/payment-authorization`,
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
      payload: { action: 'approve' },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(firstBody);

    const owner = await pool.connect();
    try {
      const rows = await owner.query(
        `SELECT actor_kind FROM payment_gate_decision WHERE client_id = $1 AND audit_run_id = $2`,
        [clientId, auditRunId],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].actor_kind).toBe('analyst');
    } finally {
      owner.release();
    }
  });

  it('rejects do_not_pay as an analyst-submitted action', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/audit-runs/${auditRunId}/payment-authorization`,
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
      payload: { action: 'do_not_pay' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/audit-runs/${auditRunId}/payment-authorization`,
      payload: { action: 'approve' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 for an unknown audit run id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/audit-runs/00000000-0000-0000-0000-000000000000/payment-authorization`,
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
      payload: { action: 'hold' },
    });
    expect(res.statusCode).toBe(404);
  });
});
