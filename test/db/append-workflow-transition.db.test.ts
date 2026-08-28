import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import {
  appendWorkflowTransition,
  AppendWorkflowTransitionError,
} from '../../src/modules/workflow/append-workflow-transition.js';
import { WorkflowTransitionError } from '../../src/modules/workflow/validate-workflow-transition.js';
import { createWorkflowInstance } from '../../src/modules/workflow/create-workflow-instance.js';

/**
 * 86e2zfh05: append-only workflow transitions (P4.A.2), layered on
 * workflow_instance (P4.A.1/#160, now merged as migration 0046).
 */
describe('appendWorkflowTransition (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  const tag = `wft-${Date.now()}`;
  const transitions = { draft: ['sent'], sent: ['accepted', 'rejected'] };

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('WFT', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM workflow_transition WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM workflow_instance WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  async function seedInstance(client: pg.PoolClient): Promise<string> {
    const created = await createWorkflowInstance(client, {
      clientId,
      workflowType: 'dispute_lifecycle',
      subjectEntity: 'dispute',
      subjectEntityId: randomUUID(),
      initialState: 'draft',
    });
    return created.id;
  }

  it('transitions current_state and appends an immutable transition row', async () => {
    const row = await withTenantTx({ clientIds: [clientId] }, async (c) => {
      const instanceId = await seedInstance(c);
      const result = await appendWorkflowTransition(c, { clientId, workflowInstanceId: instanceId, toState: 'sent' }, transitions);
      const state = await c.query(`SELECT current_state FROM workflow_instance WHERE id = $1`, [instanceId]);
      const log = await c.query(
        `SELECT from_state, to_state FROM workflow_transition WHERE client_id = $1 AND workflow_instance_id = $2`,
        [clientId, instanceId],
      );
      return { result, state: state.rows[0], log: log.rows };
    });

    expect(row.result.found).toBe(true);
    expect(row.state.current_state).toBe('sent');
    expect(row.log).toHaveLength(1);
    expect(row.log[0]).toMatchObject({ from_state: 'draft', to_state: 'sent' });
  });

  it('rejects an illegal transition and writes nothing', async () => {
    await withTenantTx({ clientIds: [clientId] }, async (c) => {
      const instanceId = await seedInstance(c);
      await expect(
        appendWorkflowTransition(c, { clientId, workflowInstanceId: instanceId, toState: 'accepted' }, transitions),
      ).rejects.toBeInstanceOf(WorkflowTransitionError);

      const log = await c.query(`SELECT id FROM workflow_transition WHERE workflow_instance_id = $1`, [instanceId]);
      expect(log.rows).toHaveLength(0);
      const state = await c.query(`SELECT current_state FROM workflow_instance WHERE id = $1`, [instanceId]);
      expect(state.rows[0].current_state).toBe('draft');
    });
  });

  it('allows and logs a same-state transition (idempotent retry)', async () => {
    const row = await withTenantTx({ clientIds: [clientId] }, async (c) => {
      const instanceId = await seedInstance(c);
      const result = await appendWorkflowTransition(c, { clientId, workflowInstanceId: instanceId, toState: 'draft' }, transitions);
      const log = await c.query(`SELECT from_state, to_state FROM workflow_transition WHERE workflow_instance_id = $1`, [instanceId]);
      return { result, log: log.rows };
    });

    expect(row.result.found).toBe(true);
    expect(row.log).toEqual([{ from_state: 'draft', to_state: 'draft' }]);
  });

  it('fails closed for an unknown workflow_instance_id', async () => {
    await withTenantTx({ clientIds: [clientId] }, (c) =>
      expect(
        appendWorkflowTransition(c, { clientId, workflowInstanceId: '00000000-0000-0000-0000-000000000000', toState: 'sent' }, transitions),
      ).rejects.toBeInstanceOf(AppendWorkflowTransitionError),
    );
  });
});
