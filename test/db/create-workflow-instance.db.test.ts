import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { createWorkflowInstance, getWorkflowInstance } from '../../src/modules/workflow/create-workflow-instance.js';

/**
 * 86e2zfgyc (P4.A.1): workflow_instance schema. Teardown order is
 * deepest-child-first (audit_event -> workflow_instance -> client), the
 * inverse of the FK graph -- mirrors update-finding-status.db.test.ts.
 */
describe('workflow_instance (DB)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let clientBId: string;
  const tag = `wfi-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('WFI-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const b = await owner.query(`INSERT INTO client (name, slug) VALUES ('WFI-B', $1) RETURNING id`, [`${tag}-b`]);
      clientBId = b.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM workflow_instance WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM client WHERE id IN ($1, $2)`, [clientAId, clientBId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('AC1: creates a workflow_instance and writes a workflow.created audit event', async () => {
    const { row, ledger } = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const created = await createWorkflowInstance(c, {
        clientId: clientAId,
        workflowType: 'claim_recovery',
        subjectEntity: 'claim',
        subjectEntityId: '00000000-0000-0000-0000-000000000001',
        initialState: 'opened',
      });
      const ledger = await c.query(
        `SELECT event, actor_kind, detail FROM audit_event WHERE entity = 'workflow_instance' AND entity_id = $1`,
        [created.id],
      );
      return { row: created, ledger: ledger.rows[0] };
    });

    expect(row.currentState).toBe('opened');
    expect(row.workflowType).toBe('claim_recovery');
    expect(typeof row.createdAt).toBe('string');
    expect(ledger).toMatchObject({
      event: 'workflow.created',
      actor_kind: 'system',
      detail: expect.objectContaining({ workflowType: 'claim_recovery', initialState: 'opened' }),
    });
  });

  it('AC2 (idempotent retry): a second create for the same subject returns the existing row, writes no duplicate', async () => {
    const subjectId = '00000000-0000-0000-0000-000000000002';
    const { first, second, count } = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const first = await createWorkflowInstance(c, {
        clientId: clientAId, workflowType: 'claim_recovery', subjectEntity: 'claim',
        subjectEntityId: subjectId, initialState: 'opened',
      });
      const second = await createWorkflowInstance(c, {
        clientId: clientAId, workflowType: 'claim_recovery', subjectEntity: 'claim',
        subjectEntityId: subjectId, initialState: 'opened',
      });
      const count = await c.query(
        `SELECT count(*)::int AS n FROM workflow_instance WHERE client_id = $1 AND subject_entity_id = $2`,
        [clientAId, subjectId],
      );
      return { first, second, count: count.rows[0].n };
    });

    expect(second.id).toBe(first.id);
    expect(count).toBe(1);
  });

  it('AC3 (fail-safe / tenant isolation): a workflow_instance from another tenant is invisible under RLS', async () => {
    const id = await withTenantTx({ clientIds: [clientBId], internal: true }, (c) =>
      createWorkflowInstance(c, {
        clientId: clientBId, workflowType: 'claim_recovery', subjectEntity: 'claim',
        subjectEntityId: '00000000-0000-0000-0000-000000000003', initialState: 'opened',
      }).then((r) => r.id),
    );

    const seenFromA = await withTenantTx({ clientIds: [clientAId], internal: false }, (c) =>
      getWorkflowInstance(c, id),
    );
    expect(seenFromA).toBeNull();

    const seenInternally = await withTenantTx({ clientIds: [], internal: true }, (c) => getWorkflowInstance(c, id));
    expect(seenInternally?.id).toBe(id);
  });

  it('AC4 (duplicate/retry stability): concurrent creates for the same subject never violate the UNIQUE constraint', async () => {
    const subjectId = '00000000-0000-0000-0000-000000000004';
    const results = await withTenantTx({ clientIds: [clientAId], internal: true }, (c) =>
      Promise.all([
        createWorkflowInstance(c, {
          clientId: clientAId, workflowType: 'dispute_lifecycle', subjectEntity: 'dispute',
          subjectEntityId: subjectId, initialState: 'opened',
        }),
        createWorkflowInstance(c, {
          clientId: clientAId, workflowType: 'dispute_lifecycle', subjectEntity: 'dispute',
          subjectEntityId: subjectId, initialState: 'opened',
        }),
      ]),
    );

    expect(results[0].id).toBe(results[1].id);
  });

  it('getWorkflowInstance returns null for an unknown id (fails closed, not an error)', async () => {
    const result = await withTenantTx({ clientIds: [clientAId], internal: true }, (c) =>
      getWorkflowInstance(c, '00000000-0000-0000-0000-00000000dead'),
    );
    expect(result).toBeNull();
  });
});
