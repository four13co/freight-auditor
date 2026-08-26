import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { buildApp } from '../../src/server/app.js';

/**
 * 86e2v1xyr, exercised at the HTTP layer: PATCH /api/findings/:id/status.
 * The first mutating route in the app.
 *
 * 86e2v1bbr gated the dev-header path behind DEV_AUTH_HEADERS (unset = a
 * verified better-auth session is required instead) -- this suite is about
 * the status-transition route's own behavior, not auth, so it sets the flag
 * for its own process rather than standing up a real session per test.
 */
describe('PATCH /api/findings/:id/status (DB, e2e)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let clientId: string;
  let otherClientId: string;
  let userId: string;
  let otherUserId: string;
  let carrierId: string;
  let originalFlag: string | undefined;
  const tag = `ufse-${Date.now()}`;

  beforeAll(async () => {
    originalFlag = process.env.DEV_AUTH_HEADERS;
    process.env.DEV_AUTH_HEADERS = '1';
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('UFSE', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const oc = await owner.query(`INSERT INTO client (name, slug) VALUES ('UFSE-OTHER', $1) RETURNING id`, [`${tag}-other`]);
      otherClientId = oc.rows[0].id;
      const u = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}@example.com`]);
      userId = u.rows[0].id;
      const ou = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-other@example.com`]);
      otherUserId = ou.rows[0].id;
      await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_viewer')`, [userId, clientId]);
      await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_viewer')`, [otherUserId, otherClientId]);
      const carrier = await owner.query(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [`Carrier-${tag}`]);
      carrierId = carrier.rows[0].id;
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
      await owner.query(`DELETE FROM audit_event WHERE client_id IN ($1, $2)`, [clientId, otherClientId]);
      await owner.query(`DELETE FROM finding_status_event WHERE client_id IN ($1, $2)`, [clientId, otherClientId]);
      await owner.query(`DELETE FROM variance_finding WHERE client_id IN ($1, $2)`, [clientId, otherClientId]);
      await owner.query(`DELETE FROM charge_fact WHERE client_id IN ($1, $2)`, [clientId, otherClientId]);
      await owner.query(`DELETE FROM audit_run WHERE client_id IN ($1, $2)`, [clientId, otherClientId]);
      await owner.query(`DELETE FROM invoice WHERE client_id IN ($1, $2)`, [clientId, otherClientId]);
      await owner.query(`DELETE FROM carrier WHERE id = $1`, [carrierId]);
      await owner.query(`DELETE FROM membership WHERE client_id IN ($1, $2)`, [clientId, otherClientId]);
      await owner.query(`DELETE FROM app_user WHERE id IN ($1, $2)`, [userId, otherUserId]);
      await owner.query(`DELETE FROM client WHERE id IN ($1, $2)`, [clientId, otherClientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  async function seedFinding(forClientId: string, variance = '100.0000'): Promise<string> {
    return withTenantTx({ clientIds: [forClientId], internal: true }, async (c) => {
      const inv = await c.query(
        `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version)
         VALUES ($1, $2, '210', $3, 'USD', 'test') RETURNING id`,
        [forClientId, carrierId, `INV-${tag}-${Math.random().toString(36).slice(2)}`],
      );
      const run = await c.query(
        `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'test', 'SCORED') RETURNING id`,
        [forClientId, inv.rows[0].id],
      );
      const cf = await c.query(
        `INSERT INTO charge_fact (client_id, invoice_id, code, category, amount, currency) VALUES ($1, $2, '400', 'LINEHAUL', '1000.0000', 'USD') RETURNING id`,
        [forClientId, inv.rows[0].id],
      );
      const vf = await c.query(
        `INSERT INTO variance_finding (client_id, audit_run_id, charge_fact_id, direction, variance_amount, currency, status)
         VALUES ($1, $2, $3, 'OVERCHARGE', $4, 'USD', 'open') RETURNING id`,
        [forClientId, run.rows[0].id, cf.rows[0].id, variance],
      );
      return vf.rows[0].id as string;
    });
  }

  it('AC1: a valid transition updates status and writes a finding_status_event row', async () => {
    const id = await seedFinding(clientId);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/findings/${id}/status`,
      headers: { 'x-client-id': clientId, 'x-user-id': userId, 'content-type': 'application/json' },
      payload: { status: 'in_review' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, status: 'in_review' });

    const check = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const row = await c.query(`SELECT status FROM variance_finding WHERE id = $1`, [id]);
      const ev = await c.query(`SELECT from_status, to_status, actor_kind FROM finding_status_event WHERE variance_finding_id = $1`, [id]);
      return { status: row.rows[0].status, event: ev.rows[0] };
    });
    expect(check.status).toBe('in_review');
    expect(check.event).toMatchObject({ from_status: 'open', to_status: 'in_review', actor_kind: 'analyst' });
  });

  it('AC2: GET /api/findings/summary reflects the transition (recoverableOpen decreases by the finding\'s variance)', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/api/findings/summary',
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    const beforeOpen = Number(before.json().recoverableOpen);

    const id = await seedFinding(clientId, '250.0000');
    const afterSeed = await app.inject({
      method: 'GET',
      url: '/api/findings/summary',
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(Number(afterSeed.json().recoverableOpen) - beforeOpen).toBeCloseTo(250, 4);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/findings/${id}/status`,
      headers: { 'x-client-id': clientId, 'x-user-id': userId, 'content-type': 'application/json' },
      payload: { status: 'closed' },
    });
    expect(patch.statusCode).toBe(200);

    const afterPatch = await app.inject({
      method: 'GET',
      url: '/api/findings/summary',
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(Number(afterPatch.json().recoverableOpen)).toBeCloseTo(beforeOpen, 4);
  });

  it('AC4: no tenant-auth headers returns 401', async () => {
    const id = await seedFinding(clientId);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/findings/${id}/status`,
      payload: { status: 'in_review' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('AC5: a finding_id belonging to another tenant returns 404, not that tenant\'s row mutated', async () => {
    const id = await seedFinding(otherClientId);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/findings/${id}/status`,
      headers: { 'x-client-id': clientId, 'x-user-id': userId, 'content-type': 'application/json' },
      payload: { status: 'in_review' },
    });
    expect(res.statusCode).toBe(404);

    const stillOpen = await withTenantTx({ clientIds: [otherClientId], internal: true }, async (c) => {
      const row = await c.query(`SELECT status FROM variance_finding WHERE id = $1`, [id]);
      return row.rows[0].status;
    });
    expect(stillOpen).toBe('open');
  });

  it('an invalid status value returns 400', async () => {
    const id = await seedFinding(clientId);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/findings/${id}/status`,
      headers: { 'x-client-id': clientId, 'x-user-id': userId, 'content-type': 'application/json' },
      payload: { status: 'accepted' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('AC6: two sequential PATCH calls both appear in finding_status_event, in order', async () => {
    const id = await seedFinding(clientId);
    const headers = { 'x-client-id': clientId, 'x-user-id': userId, 'content-type': 'application/json' };
    await app.inject({ method: 'PATCH', url: `/api/findings/${id}/status`, headers, payload: { status: 'in_review' } });
    await app.inject({ method: 'PATCH', url: `/api/findings/${id}/status`, headers, payload: { status: 'disputed' } });

    const events = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const ev = await c.query(
        `SELECT from_status, to_status FROM finding_status_event WHERE variance_finding_id = $1 ORDER BY recorded_at ASC`,
        [id],
      );
      return ev.rows;
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ from_status: 'open', to_status: 'in_review' });
    expect(events[1]).toMatchObject({ from_status: 'in_review', to_status: 'disputed' });
  });
});
