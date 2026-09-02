import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { listDisputesDueForResponse, type DisputeResponseQueueEntry } from '../../src/modules/disputes/list-dispute-response-queue.js';
import { buildApp } from '../../src/server/app.js';
import type { FastifyInstance } from 'fastify';

/**
 * P4.C.10: the dispute-response aging query, exercised against real
 * Postgres -- seeded rows prove the actual filtering behavior the mocked
 * unit tests (test/unit/list-dispute-response-queue.test.ts) can only assert
 * the SQL text for. Old-comm timestamps are seeded directly via SQL
 * (dispute_comm.recorded_at has a DEFAULT now(), so an "overdue" row must
 * override it explicitly), matching dispute-comm.db.test.ts's own approach.
 */
describe('listDisputesDueForResponse (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  const tag = `drq-${Date.now()}`;
  const NOW = new Date('2026-09-02T00:00:00.000Z');
  const OLD = '2026-08-20T00:00:00.000Z'; // 13 days before NOW -- past the 5-day default threshold
  const RECENT = '2026-09-01T12:00:00.000Z'; // 12 hours before NOW -- inside the threshold

  beforeAll(async () => {
    pool = getPool();
    const c = await pool.query(`INSERT INTO client (name, slug) VALUES ('DRQ', $1) RETURNING id`, [tag]);
    clientId = c.rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM dispute_comm WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM dispute WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    await closePool();
  });

  async function seedDispute(status: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO dispute (client_id, status, amount_claimed, currency) VALUES ($1, $2, '500.0000', 'USD') RETURNING id`,
      [clientId, status],
    );
    return rows[0]!.id;
  }

  async function seedComm(disputeId: string, direction: 'outbound' | 'inbound', recordedAt: string): Promise<void> {
    await pool.query(
      `INSERT INTO dispute_comm (client_id, dispute_id, direction, body, recorded_at, dedupe_key)
       VALUES ($1, $2, $3, 'test comm', $4, $5)`,
      [clientId, disputeId, direction, recordedAt, `${disputeId}:${direction}:${recordedAt}`],
    );
  }

  async function query(): Promise<DisputeResponseQueueEntry[]> {
    return withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      listDisputesDueForResponse(client, clientId, NOW));
  }

  it('AC1: includes a sent dispute whose most recent comm is outbound and older than the threshold', async () => {
    const disputeId = await seedDispute('sent');
    await seedComm(disputeId, 'outbound', OLD);

    const result = await query();

    expect(result.some((r) => r.disputeId === disputeId)).toBe(true);
  });

  it('AC2: excludes a dispute whose most recent comm is inbound (the carrier already responded)', async () => {
    const disputeId = await seedDispute('sent');
    await seedComm(disputeId, 'outbound', OLD);
    await seedComm(disputeId, 'inbound', RECENT);

    const result = await query();

    expect(result.some((r) => r.disputeId === disputeId)).toBe(false);
  });

  it('AC2: excludes a dispute whose status is draft/accepted/rejected/closed even with an old outbound comm', async () => {
    for (const status of ['draft', 'accepted', 'rejected', 'closed']) {
      const disputeId = await seedDispute(status);
      await seedComm(disputeId, 'outbound', OLD);

      const result = await query();

      expect(result.some((r) => r.disputeId === disputeId)).toBe(false);
    }
  });

  it('AC2: excludes a dispute whose outbound comm is within the threshold', async () => {
    const disputeId = await seedDispute('sent');
    await seedComm(disputeId, 'outbound', RECENT);

    const result = await query();

    expect(result.some((r) => r.disputeId === disputeId)).toBe(false);
  });

  it('AC3: excludes a dispute that has never had any dispute_comm', async () => {
    const disputeId = await seedDispute('draft');

    const result = await query();

    expect(result.some((r) => r.disputeId === disputeId)).toBe(false);
  });

  it('the explicit clientId predicate rejects a mismatched clientId even under an internal (cross-client) RLS scope', async () => {
    const disputeId = await seedDispute('sent');
    await seedComm(disputeId, 'outbound', OLD);

    const otherClientId = '00000000-0000-4000-8000-000000000099';
    const rows = await withTenantTx({ internal: true }, (client) =>
      listDisputesDueForResponse(client, otherClientId, NOW));

    expect(rows.some((r) => r.disputeId === disputeId)).toBe(false);
  });
});

/**
 * AC4: GET /api/disputes/queues, exercised at the HTTP layer with the
 * dev-header identity source (DEV_AUTH_HEADERS=1), same pattern as
 * claim-recovery-endpoint.db.test.ts -- proves the route is correctly
 * RLS-scoped to the authenticated tenant, not just the query module in
 * isolation.
 */
describe('GET /api/disputes/queues (DB, e2e)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let clientId: string;
  let userId: string;
  let originalFlag: string | undefined;
  const tag = `drqe-${Date.now()}`;

  beforeAll(async () => {
    originalFlag = process.env.DEV_AUTH_HEADERS;
    process.env.DEV_AUTH_HEADERS = '1';
    pool = getPool();
    const c = await pool.query(`INSERT INTO client (name, slug) VALUES ('DRQE', $1) RETURNING id`, [tag]);
    clientId = c.rows[0].id;
    const u = await pool.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}@example.com`]);
    userId = u.rows[0].id;
    await pool.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'analyst')`, [userId, clientId]);
    app = buildApp();
  });

  afterAll(async () => {
    process.env.DEV_AUTH_HEADERS = originalFlag;
    await app.close();
    await pool.query(`DELETE FROM dispute_comm WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM dispute WHERE client_id = $1`, [clientId]);
    await pool.query(`DELETE FROM membership WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM app_user WHERE id = $1`, [userId]);
    await pool.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    await closePool();
  });

  it('returns only the authenticated tenant\'s overdue disputes', async () => {
    const dispute = await pool.query<{ id: string }>(
      `INSERT INTO dispute (client_id, status, amount_claimed, currency) VALUES ($1, 'sent', '500.0000', 'USD') RETURNING id`,
      [clientId],
    );
    const disputeId = dispute.rows[0]!.id;
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await pool.query(
      `INSERT INTO dispute_comm (client_id, dispute_id, direction, body, recorded_at, dedupe_key)
       VALUES ($1, $2, 'outbound', 'overdue comm', $3, $4)`,
      [clientId, disputeId, old, `${disputeId}:seed`],
    );

    const res = await app.inject({
      method: 'GET', url: '/api/disputes/queues', headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().overdue.some((r: { disputeId: string }) => r.disputeId === disputeId)).toBe(true);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/disputes/queues' });
    expect(res.statusCode).toBe(401);
  });

  it('cross-tenant: an authenticated tenant-A user cannot see a tenant-B overdue dispute', async () => {
    const other = await pool.query(`INSERT INTO client (name, slug) VALUES ('DRQE-other', $1) RETURNING id`, [`${tag}-other`]);
    const otherClientId = other.rows[0].id;
    const otherDispute = await pool.query<{ id: string }>(
      `INSERT INTO dispute (client_id, status, amount_claimed, currency) VALUES ($1, 'sent', '900.0000', 'USD') RETURNING id`,
      [otherClientId],
    );
    const otherDisputeId = otherDispute.rows[0]!.id;
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await pool.query(
      `INSERT INTO dispute_comm (client_id, dispute_id, direction, body, recorded_at, dedupe_key)
       VALUES ($1, $2, 'outbound', 'other comm', $3, $4)`,
      [otherClientId, otherDisputeId, old, `${otherDisputeId}:seed`],
    );

    const res = await app.inject({
      method: 'GET', url: '/api/disputes/queues', headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().overdue.some((r: { disputeId: string }) => r.disputeId === otherDisputeId)).toBe(false);

    await pool.query(`DELETE FROM dispute_comm WHERE client_id = $1`, [otherClientId]);
    await pool.query(`DELETE FROM dispute WHERE client_id = $1`, [otherClientId]);
    await pool.query(`DELETE FROM client WHERE id = $1`, [otherClientId]);
  });
});
