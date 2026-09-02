import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { getDisputeDetail } from '../../src/modules/disputes/get-dispute-detail.js';
import {
  acceptDispute,
  rejectDispute,
  partiallyAcceptDispute,
  closeDispute,
  DisputeTransitionError,
} from '../../src/modules/disputes/resolve-dispute.js';

/**
 * P4.C.9, against real Postgres: the carrier-response lifecycle
 * (accepted/rejected/partial, then closed) proved through dispute's own
 * FORCE RLS (migration 0009) -- mirrors dispute-review.db.test.ts's own
 * seeding + deepest-child-first teardown shape (86e30txkx FK-order lesson).
 */
describe('resolve-dispute (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  let otherClientId: string;
  let actorUserId: string;
  const tag = `rd-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('RD', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const c2 = await owner.query(`INSERT INTO client (name, slug) VALUES ('RD-other', $1) RETURNING id`, [`${tag}-other`]);
      otherClientId = c2.rows[0].id;
      const u = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}@example.com`]);
      actorUserId = u.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM dispute WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
      await owner.query(`DELETE FROM app_user WHERE id = $1`, [actorUserId]);
      await owner.query(`DELETE FROM client WHERE id = ANY($1)`, [[clientId, otherClientId]]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  async function seedSentDispute(client: pg.PoolClient, ownerClientId: string, amountClaimed = '500.0000'): Promise<string> {
    const dispute = await client.query(
      `INSERT INTO dispute (client_id, status, amount_claimed, currency) VALUES ($1, 'sent', $2, 'USD') RETURNING id`,
      [ownerClientId, amountClaimed],
    );
    return dispute.rows[0].id;
  }

  it('accepts a sent dispute (sent -> accepted) and a second accept is a no-op', async () => {
    const owner = await pool.connect();
    try {
      const disputeId = await seedSentDispute(owner, clientId);

      const first = await withTenantTx({ clientIds: [clientId], internal: false }, (client) => acceptDispute(client, disputeId, actorUserId));
      expect(first).toEqual({ found: true });

      const detail = await withTenantTx({ clientIds: [clientId], internal: false }, (client) => getDisputeDetail(client, disputeId));
      expect(detail?.status).toBe('accepted');

      const second = await withTenantTx({ clientIds: [clientId], internal: false }, (client) => acceptDispute(client, disputeId, actorUserId));
      expect(second).toEqual({ found: false });
    } finally {
      owner.release();
    }
  });

  it('rejects a sent dispute (sent -> rejected)', async () => {
    const owner = await pool.connect();
    try {
      const disputeId = await seedSentDispute(owner, clientId);

      const result = await withTenantTx({ clientIds: [clientId], internal: false }, (client) => rejectDispute(client, disputeId, actorUserId));
      expect(result).toEqual({ found: true });

      const detail = await withTenantTx({ clientIds: [clientId], internal: false }, (client) => getDisputeDetail(client, disputeId));
      expect(detail?.status).toBe('rejected');
    } finally {
      owner.release();
    }
  });

  it('partially accepts a sent dispute (sent -> partial) and records accepted_amount', async () => {
    const owner = await pool.connect();
    try {
      const disputeId = await seedSentDispute(owner, clientId, '500.0000');

      const result = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
        partiallyAcceptDispute(client, disputeId, actorUserId, '300.0000'));
      expect(result).toEqual({ found: true });

      const { rows } = await pool.query(`SELECT status, accepted_amount FROM dispute WHERE id = $1`, [disputeId]);
      expect(rows[0].status).toBe('partial');
      expect(rows[0].accepted_amount).toBe('300.0000');
    } finally {
      owner.release();
    }
  });

  it('rejects an accepted amount above amount_claimed with a real DB row already in place, writing nothing', async () => {
    const owner = await pool.connect();
    try {
      const disputeId = await seedSentDispute(owner, clientId, '500.0000');

      await expect(withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
        partiallyAcceptDispute(client, disputeId, actorUserId, '600.0000'))).rejects.toThrow(DisputeTransitionError);

      const { rows } = await pool.query(`SELECT status, accepted_amount FROM dispute WHERE id = $1`, [disputeId]);
      expect(rows[0].status).toBe('sent');
      expect(rows[0].accepted_amount).toBeNull();
    } finally {
      owner.release();
    }
  });

  it('closes an accepted dispute (accepted -> closed) and a second close is a no-op', async () => {
    const owner = await pool.connect();
    try {
      const disputeId = await seedSentDispute(owner, clientId);
      await withTenantTx({ clientIds: [clientId], internal: false }, (client) => acceptDispute(client, disputeId, actorUserId));

      const first = await withTenantTx({ clientIds: [clientId], internal: false }, (client) => closeDispute(client, disputeId, actorUserId));
      expect(first).toEqual({ found: true });

      const detail = await withTenantTx({ clientIds: [clientId], internal: false }, (client) => getDisputeDetail(client, disputeId));
      expect(detail?.status).toBe('closed');

      const second = await withTenantTx({ clientIds: [clientId], internal: false }, (client) => closeDispute(client, disputeId, actorUserId));
      expect(second).toEqual({ found: false });
    } finally {
      owner.release();
    }
  });

  it('reports found: false closing a dispute still awaiting a carrier response (nothing to close yet)', async () => {
    const owner = await pool.connect();
    try {
      const disputeId = await seedSentDispute(owner, clientId);
      const result = await withTenantTx({ clientIds: [clientId], internal: false }, (client) => closeDispute(client, disputeId, actorUserId));
      expect(result).toEqual({ found: false });
    } finally {
      owner.release();
    }
  });

  it('cross-tenant isolation: a dispute belonging to another client is invisible under RLS, so every transition reports found: false', async () => {
    const owner = await pool.connect();
    try {
      const disputeId = await seedSentDispute(owner, otherClientId);

      const accept = await withTenantTx({ clientIds: [clientId], internal: false }, (client) => acceptDispute(client, disputeId, actorUserId));
      expect(accept).toEqual({ found: false });

      const reject = await withTenantTx({ clientIds: [clientId], internal: false }, (client) => rejectDispute(client, disputeId, actorUserId));
      expect(reject).toEqual({ found: false });

      const partial = await withTenantTx({ clientIds: [clientId], internal: false }, (client) =>
        partiallyAcceptDispute(client, disputeId, actorUserId, '100.0000'));
      expect(partial).toEqual({ found: false });

      // Still visible and untouched under its OWNING tenant's scope.
      const detail = await withTenantTx({ clientIds: [otherClientId], internal: false }, (client) => getDisputeDetail(client, disputeId));
      expect(detail?.status).toBe('sent');
    } finally {
      owner.release();
    }
  });
});
