import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { buildApp } from '../../src/server/app.js';

/**
 * P4.B.6: GET /api/payment-authorizations/pending, exercised at the HTTP
 * layer. Uses the dev-header identity source (DEV_AUTH_HEADERS=1), same
 * pattern as payment-authorization-endpoint.db.test.ts.
 */
describe('GET /api/payment-authorizations/pending (DB, e2e)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let clientId: string;
  let userId: string;
  let originalFlag: string | undefined;
  const tag = `ppae-${Date.now()}`;

  beforeAll(async () => {
    originalFlag = process.env.DEV_AUTH_HEADERS;
    process.env.DEV_AUTH_HEADERS = '1';
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('PPAE', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const u = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}@example.com`]);
      userId = u.rows[0].id;
      await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'analyst')`, [userId, clientId]);
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

  async function makeAuditRun(invoiceNumber: string): Promise<string> {
    return withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const carrier = await c.query(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [`Carrier-${invoiceNumber}`]);
      const inv = await c.query(
        `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version)
         VALUES ($1, $2, '210', $3, 'USD', 'test') RETURNING id`,
        [clientId, carrier.rows[0].id, invoiceNumber],
      );
      const run = await c.query(
        `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'test', 'SCORED') RETURNING id`,
        [clientId, inv.rows[0].id],
      );
      return run.rows[0].id;
    });
  }

  it('lists a held audit run and stops listing it once approved', async () => {
    const auditRunId = await makeAuditRun(`INV-${tag}`);

    const hold = await app.inject({
      method: 'POST',
      url: `/api/audit-runs/${auditRunId}/payment-authorization`,
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
      payload: { action: 'hold' },
    });
    expect(hold.statusCode).toBe(201);

    const before = await app.inject({
      method: 'GET',
      url: '/api/payment-authorizations/pending',
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(before.statusCode).toBe(200);
    const beforeBody = before.json() as { pending: Array<{ auditRunId: string; invoiceNumber: string | null }> };
    expect(beforeBody.pending.some((row) => row.auditRunId === auditRunId)).toBe(true);
    expect(beforeBody.pending.find((row) => row.auditRunId === auditRunId)?.invoiceNumber).toBe(`INV-${tag}`);

    const approve = await app.inject({
      method: 'POST',
      url: `/api/audit-runs/${auditRunId}/payment-authorization`,
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
      payload: { action: 'approve' },
    });
    expect(approve.statusCode).toBe(201);

    const after = await app.inject({
      method: 'GET',
      url: '/api/payment-authorizations/pending',
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    const afterBody = after.json() as { pending: Array<{ auditRunId: string }> };
    expect(afterBody.pending.some((row) => row.auditRunId === auditRunId)).toBe(false);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/payment-authorizations/pending' });
    expect(res.statusCode).toBe(401);
  });
});
