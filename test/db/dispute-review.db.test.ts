import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { getDisputeDetail } from '../../src/modules/disputes/get-dispute-detail.js';
import { approveDispute } from '../../src/modules/disputes/approve-dispute.js';

/**
 * approveDispute's writeAuditEvent call inserts actor_user_id referencing
 * the caller-supplied actor -- audit_event has a real FK to app_user(id),
 * so the actor here must be a seeded app_user row, not a fabricated literal
 * (86e2zfhpm's own history: PR #207 used a hardcoded UUID and failed CI
 * with a genuine 23503 FK violation, not a flake). Seeded here the same way
 * as claim-endpoint.db.test.ts.
 *
 * Teardown deepest-child-first: audit_event -> dispute_line -> dispute ->
 * app_user -> client.
 */
describe('dispute review (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  let actorUserId: string;
  const tag = `dr-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('DR', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const u = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}@example.com`]);
      actorUserId = u.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM dispute_line WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM dispute WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM app_user WHERE id = $1`, [actorUserId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  async function seedDraftDispute(client: pg.PoolClient): Promise<string> {
    const dispute = await client.query(
      `INSERT INTO dispute (client_id, status, amount_claimed, currency) VALUES ($1, 'draft', '500.0000', 'USD') RETURNING id`,
      [clientId],
    );
    const disputeId = dispute.rows[0].id;
    await client.query(
      `INSERT INTO dispute_line (client_id, dispute_id, amount, currency) VALUES ($1, $2, '500.0000', 'USD')`,
      [clientId, disputeId],
    );
    return disputeId;
  }

  it('fetches a dispute with its lines', async () => {
    const owner = await pool.connect();
    try {
      const disputeId = await seedDraftDispute(owner);
      const result = await withTenantTx({ clientIds: [clientId], internal: false }, (client) => getDisputeDetail(client, disputeId));
      expect(result).toMatchObject({ id: disputeId, status: 'draft', amountClaimed: '500.0000', currency: 'USD' });
      expect(result?.lines).toHaveLength(1);
    } finally {
      owner.release();
    }
  });

  it('returns null for an unknown dispute id', async () => {
    const result = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
      getDisputeDetail(client, '99999999-9999-4999-8999-999999999999'));
    expect(result).toBeNull();
  });

  it('approves a draft dispute (draft -> sent) and a second approval is a no-op', async () => {
    const owner = await pool.connect();
    try {
      const disputeId = await seedDraftDispute(owner);

      const first = await withTenantTx({ clientIds: [clientId], internal: false }, (client) => approveDispute(client, disputeId, actorUserId));
      expect(first).toEqual({ found: true });

      const detail = await withTenantTx({ clientIds: [clientId], internal: false }, (client) => getDisputeDetail(client, disputeId));
      expect(detail?.status).toBe('sent');

      const second = await withTenantTx({ clientIds: [clientId], internal: false }, (client) => approveDispute(client, disputeId, actorUserId));
      expect(second).toEqual({ found: false });
    } finally {
      owner.release();
    }
  });
});
