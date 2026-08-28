import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { createWorkflowInstance, getWorkflowInstance } from '../../src/modules/workflow/create-workflow-instance.js';

/**
 * Unit-level coverage of createWorkflowInstance/getWorkflowInstance's query
 * shape and row mapping via a mocked pg client -- no live DB.
 * test/db/create-workflow-instance.db.test.ts covers the same functions
 * against real Postgres (RLS, the UNIQUE constraint, concurrent-create
 * safety) and stays the source of truth for that behavior; this file exists
 * so the default coverage gate (test/db/** excluded) also exercises this
 * module -- same reasoning as findings-summary.test.ts.
 */
const WF_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const SUBJECT_ID = '33333333-3333-4333-8333-333333333333';
const AUDIT_ID = '44444444-4444-4444-8444-444444444444';

const rawRow = {
  id: WF_ID, client_id: CLIENT_ID, workflow_type: 'claim_recovery',
  subject_entity: 'claim', subject_entity_id: SUBJECT_ID, current_state: 'opened',
  created_at: new Date('2026-01-01T00:00:00Z'), updated_at: new Date('2026-01-01T00:00:00Z'),
};

function mockClient(queryImpl: (sql: string, params: unknown[]) => { rows: unknown[] }) {
  const query = vi.fn().mockImplementation(async (sql: string, params: unknown[]) => queryImpl(sql, params));
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('createWorkflowInstance (unit, mocked client)', () => {
  it('returns the existing row without inserting when one already exists (idempotent read)', async () => {
    const { client, query } = mockClient((sql) => {
      if (sql.includes('SELECT') && sql.includes('FROM workflow_instance')) return { rows: [rawRow] };
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await createWorkflowInstance(client, {
      clientId: CLIENT_ID, workflowType: 'claim_recovery', subjectEntity: 'claim',
      subjectEntityId: SUBJECT_ID, initialState: 'opened',
    });

    expect(result).toEqual({
      id: WF_ID, clientId: CLIENT_ID, workflowType: 'claim_recovery',
      subjectEntity: 'claim', subjectEntityId: SUBJECT_ID, currentState: 'opened',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('inserts and writes a workflow.created audit event when no row exists yet', async () => {
    let selectCalls = 0;
    const { client, query } = mockClient((sql) => {
      if (sql.includes('INSERT INTO audit_event')) return { rows: [{ id: AUDIT_ID, created: true }] };
      if (sql.includes('INSERT INTO workflow_instance')) return { rows: [rawRow] };
      if (sql.includes('SELECT') && sql.includes('FROM workflow_instance')) {
        selectCalls += 1;
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await createWorkflowInstance(client, {
      clientId: CLIENT_ID, workflowType: 'claim_recovery', subjectEntity: 'claim',
      subjectEntityId: SUBJECT_ID, initialState: 'opened',
    });

    expect(result.id).toBe(WF_ID);
    expect(selectCalls).toBe(1);
    expect(query).toHaveBeenCalledTimes(3);
    const auditCall = query.mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO audit_event'));
    expect(auditCall).toBeTruthy();
  });

  it('re-reads the winning row when INSERT ... ON CONFLICT DO NOTHING loses a concurrent race', async () => {
    const { client } = mockClient((sql) => {
      if (sql.includes('INSERT INTO workflow_instance')) return { rows: [] };
      if (sql.includes('SELECT') && sql.includes('FROM workflow_instance')) return { rows: [rawRow] };
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await createWorkflowInstance(client, {
      clientId: CLIENT_ID, workflowType: 'claim_recovery', subjectEntity: 'claim',
      subjectEntityId: SUBJECT_ID, initialState: 'opened',
    });

    expect(result.id).toBe(WF_ID);
  });

  it('throws if the post-race re-read still finds no row (defensive, should be unreachable given the UNIQUE constraint)', async () => {
    const { client } = mockClient((sql) => {
      if (sql.includes('INSERT INTO workflow_instance')) return { rows: [] };
      if (sql.includes('SELECT') && sql.includes('FROM workflow_instance')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });

    await expect(createWorkflowInstance(client, {
      clientId: CLIENT_ID, workflowType: 'claim_recovery', subjectEntity: 'claim',
      subjectEntityId: SUBJECT_ID, initialState: 'opened',
    })).rejects.toThrow('workflow_instance insert conflicted but no row was found on re-read');
  });
});

describe('getWorkflowInstance (unit, mocked client)', () => {
  it('maps a found row to the WorkflowInstanceRow shape', async () => {
    const { client } = mockClient(() => ({ rows: [rawRow] }));
    const result = await getWorkflowInstance(client, WF_ID);
    expect(result?.currentState).toBe('opened');
    expect(result?.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns null when no row is found', async () => {
    const { client } = mockClient(() => ({ rows: [] }));
    const result = await getWorkflowInstance(client, '99999999-9999-4999-8999-999999999999');
    expect(result).toBeNull();
  });
});
