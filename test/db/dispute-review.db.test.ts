import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { getDisputeDetail } from '../../src/modules/disputes/get-dispute-detail.js';
import { approveDispute } from '../../src/modules/disputes/approve-dispute.js';

const ACTOR_USER_ID = '80000000-0000-4000-8000-000000000099';

/**
 * P4.C.6. Teardown deepest-child-first (audit_event -> dispute_line ->
 * dispute -> client), following create-claim-from-dispute.db.test.ts's
 * established ordering discipline.
 */
describe('dispute review (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  const tag = `dr-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('DR', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
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

      const first = await withTenantTx({ clientIds: [clientId], internal: false }, (client) => approveDispute(client, disputeId, ACTOR_USER_ID));
      expect(first).toEqual({ found: true });

      const detail = await withTenantTx({ clientIds: [clientId], internal: false }, (client) => getDisputeDetail(client, disputeId));
      expect(detail?.status).toBe('sent');

      const second = await withTenantTx({ clientIds: [clientId], internal: false }, (client) => approveDispute(client, disputeId, ACTOR_USER_ID));
      expect(second).toEqual({ found: false });
    } finally {
      owner.release();
    }
  });
});
