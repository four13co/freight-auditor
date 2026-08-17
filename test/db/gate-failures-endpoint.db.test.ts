import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { buildApp } from '../../src/server/app.js';
import { parse210 } from '../../src/modules/ingestion/parse-210.js';
import { evaluateInvoice } from '../../src/modules/evaluator/evaluate-invoice.js';
import { persistAuditRun } from '../../src/modules/evaluator/persist.js';
import { MALFORMED_210_NOFOOT, testCategorize } from '../fixtures/edi-golden.js';

/**
 * 86e2v17xn, exercised at the HTTP layer: GET /api/gate-failures.
 */
describe('GET /api/gate-failures (DB, e2e)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let clientId: string;
  let userId: string;
  const tag = `gfe-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('GFE', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const u = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}@example.com`]);
      userId = u.rows[0].id;
      await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_viewer')`, [
        userId,
        clientId,
      ]);
      await withTenantTx({ clientIds: [clientId], internal: true }, async (c2) => {
        const inv = parse210(MALFORMED_210_NOFOOT, testCategorize);
        const result = evaluateInvoice(inv);
        await persistAuditRun(c2, { clientId, invoice: inv, result, rubricSnapshotId: null });
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
      await owner.query(`DELETE FROM gate_failure WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM audit_run WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM invoice WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM membership WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM app_user WHERE id = $1`, [userId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('returns { gateFailures } with defect/citation for the client in the request headers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/gate-failures',
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gateFailures).toHaveLength(1);
    expect(body.gateFailures[0]).toMatchObject({
      invoiceNumber: 'INV210003',
      defect: expect.stringContaining('foots'),
    });
  });

  it('returns 401 when the request has no tenant-auth headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/gate-failures' });
    expect(res.statusCode).toBe(401);
  });
});
