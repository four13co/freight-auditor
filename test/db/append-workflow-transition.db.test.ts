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
 * workflow_instance (P4.A.1/86e2zfgyc, migration 0046).
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

  it('serializes concurrent transitions: the loser re-validates against the post-commit state, never logging an unvalidated from/to pair', async () => {
    // draft has two legal targets so both calls can pass validation against
    // the same pre-race snapshot (PR #228's failure scenario) -- 'sent' has
    // only accepted/rejected, so whichever call loses the row lock and
    // re-reads 'sent' afterwards must fail validation, not silently log
    // sent -> archived (or vice versa if 'archived' wins first).
    const racy = { draft: ['sent', 'archived'], sent: ['accepted', 'rejected'] };
    const instanceId = await withTenantTx({ clientIds: [clientId] }, (c) => seedInstance(c));

    const [a, b] = await Promise.allSettled([
      withTenantTx({ clientIds: [clientId] }, (c) =>
        appendWorkflowTransition(c, { clientId, workflowInstanceId: instanceId, toState: 'sent' }, racy),
      ),
      withTenantTx({ clientIds: [clientId] }, (c) =>
        appendWorkflowTransition(c, { clientId, workflowInstanceId: instanceId, toState: 'archived' }, racy),
      ),
    ]);

    const outcomes = [a, b];
    const winners = outcomes.filter((r) => r.status === 'fulfilled');
    const losers = outcomes.filter((r) => r.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as PromiseRejectedResult).reason).toBeInstanceOf(WorkflowTransitionError);

    const owner = await pool.connect();
    let finalState: string;
    let log: Array<{ from_state: string; to_state: string }>;
    try {
      const state = await owner.query(`SELECT current_state FROM workflow_instance WHERE id = $1`, [instanceId]);
      finalState = state.rows[0].current_state;
      const rows = await owner.query(
        `SELECT from_state, to_state FROM workflow_transition WHERE workflow_instance_id = $1`,
        [instanceId],
      );
      log = rows.rows;
    } finally {
      owner.release();
    }

    // Whichever target won, exactly one transition is logged, from the real
    // pre-race state, to the state the instance actually ended up in -- the
    // loser never got to append the pair it validated against the stale
    // snapshot.
    expect(['sent', 'archived']).toContain(finalState);
    expect(log).toEqual([{ from_state: 'draft', to_state: finalState }]);
  });

  it('rejects cross-tenant access to a workflow_instance under RLS (fail-safe, not a schema error)', async () => {
    const otherOwner = await pool.connect();
    let otherClientId: string;
    try {
      const c = await otherOwner.query(`INSERT INTO client (name, slug) VALUES ('WFT-OTHER', $1) RETURNING id`, [`${tag}-other`]);
      otherClientId = c.rows[0].id;
    } finally {
      otherOwner.release();
    }

    try {
      const instanceId = await withTenantTx({ clientIds: [otherClientId] }, (c) =>
        createWorkflowInstance(c, {
          clientId: otherClientId,
          workflowType: 'dispute_lifecycle',
          subjectEntity: 'dispute',
          subjectEntityId: randomUUID(),
          initialState: 'draft',
        }).then((r) => r.id),
      );

      await withTenantTx({ clientIds: [clientId] }, (c) =>
        expect(
          appendWorkflowTransition(c, { clientId, workflowInstanceId: instanceId, toState: 'sent' }, transitions),
        ).rejects.toBeInstanceOf(AppendWorkflowTransitionError),
      );
    } finally {
      const cleanup = await pool.connect();
      try {
        await cleanup.query(`DELETE FROM audit_event WHERE client_id = $1`, [otherClientId]);
        await cleanup.query(`DELETE FROM workflow_instance WHERE client_id = $1`, [otherClientId]);
        await cleanup.query(`DELETE FROM client WHERE id = $1`, [otherClientId]);
      } finally {
        cleanup.release();
      }
    }
  });
});
