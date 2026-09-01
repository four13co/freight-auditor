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
 * Teardown deepest-child-first (86e30txkx's tracked FK-order defect class):
 * workflow_outbox_message -> workflow_command -> audit_event -> dispute_line
 * -> dispute -> workflow_instance -> app_user -> client. audit_event's own
 * entity_id is a plain uuid, not a real FK to workflow_instance/
 * workflow_command/dispute, so its only hard ordering constraint is
 * client_id/actor_user_id -- placed early here for clarity, not necessity.
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
      await owner.query(`DELETE FROM workflow_outbox_message WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM workflow_command WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM dispute_line WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM dispute WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM workflow_instance WHERE client_id = $1`, [clientId]);
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

  it('P4.C.7: creates exactly one dispute_delivery workflow_instance and one due deliver_dispute command per dispute, not duplicated on the idempotent second approve', async () => {
    const owner = await pool.connect();
    try {
      const disputeId = await seedDraftDispute(owner);

      await withTenantTx({ clientIds: [clientId], internal: false }, (client) => approveDispute(client, disputeId, actorUserId));
      // Idempotent no-op call: must not create a second instance/command.
      await withTenantTx({ clientIds: [clientId], internal: false }, (client) => approveDispute(client, disputeId, actorUserId));

      const { rows: instances } = await pool.query(
        `SELECT id, workflow_type, subject_entity, subject_entity_id, current_state
         FROM workflow_instance WHERE client_id = $1 AND subject_entity_id = $2`,
        [clientId, disputeId],
      );
      expect(instances).toHaveLength(1);
      expect(instances[0]).toMatchObject({
        workflow_type: 'dispute_delivery', subject_entity: 'dispute', subject_entity_id: disputeId, current_state: 'pending_delivery',
      });

      const { rows: commands } = await pool.query(
        `SELECT command_type, status, payload, run_after FROM workflow_command
         WHERE client_id = $1 AND workflow_instance_id = $2`,
        [clientId, instances[0].id],
      );
      expect(commands).toHaveLength(1);
      expect(commands[0].command_type).toBe('deliver_dispute');
      expect(commands[0].status).toBe('pending');
      expect(commands[0].payload).toEqual({ disputeId });
      expect(commands[0].run_after.getTime()).toBeLessThanOrEqual(Date.now());
    } finally {
      owner.release();
    }
  });
});
