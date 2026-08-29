import type pg from 'pg';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';

export interface CreateWorkflowInstanceInput {
  clientId: string;
  workflowType: string;
  subjectEntity: string;
  subjectEntityId: string;
  initialState: string;
}

export interface WorkflowInstanceRow {
  id: string;
  clientId: string;
  workflowType: string;
  subjectEntity: string;
  subjectEntityId: string;
  currentState: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Create a workflow_instance (P4.A.1, 86e2zfgyc). Idempotent on
 * (client_id, workflow_type, subject_entity, subject_entity_id): a retry with
 * the same subject returns the existing row rather than erroring or
 * duplicating, via SELECT-then-INSERT under the caller's withTenantTx (RLS
 * enforces the tenant boundary; the UNIQUE constraint is the fail-safe floor
 * if two concurrent creates race).
 *
 * State-machine legality of transitions is out of this task's boundary --
 * #169's workflow_transition validates transitions against a caller-supplied
 * map. This module only ever writes the *initial* state.
 */
export async function createWorkflowInstance(
  client: pg.PoolClient,
  input: CreateWorkflowInstanceInput,
): Promise<WorkflowInstanceRow> {
  const existing = await client.query<RawRow>(
    `SELECT id, client_id, workflow_type, subject_entity, subject_entity_id, current_state, created_at, updated_at
     FROM workflow_instance
     WHERE client_id = $1 AND workflow_type = $2 AND subject_entity = $3 AND subject_entity_id = $4`,
    [input.clientId, input.workflowType, input.subjectEntity, input.subjectEntityId],
  );
  if (existing.rows[0]) return toRow(existing.rows[0]);

  const inserted = await client.query<RawRow>(
    `INSERT INTO workflow_instance (client_id, workflow_type, subject_entity, subject_entity_id, current_state)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (client_id, workflow_type, subject_entity, subject_entity_id) DO NOTHING
     RETURNING id, client_id, workflow_type, subject_entity, subject_entity_id, current_state, created_at, updated_at`,
    [input.clientId, input.workflowType, input.subjectEntity, input.subjectEntityId, input.initialState],
  );

  const row = inserted.rows[0];
  if (!row) {
    // Lost the race to a concurrent insert -- read back the winner's row.
    const raced = await client.query<RawRow>(
      `SELECT id, client_id, workflow_type, subject_entity, subject_entity_id, current_state, created_at, updated_at
       FROM workflow_instance
       WHERE client_id = $1 AND workflow_type = $2 AND subject_entity = $3 AND subject_entity_id = $4`,
      [input.clientId, input.workflowType, input.subjectEntity, input.subjectEntityId],
    );
    const racedRow = raced.rows[0];
    if (!racedRow) throw new Error('workflow_instance insert conflicted but no row was found on re-read');
    return toRow(racedRow);
  }

  await writeAuditEvent(client, {
    id: deterministicAuditEventId(row.client_id, row.id, 'workflow.created'),
    clientId: row.client_id,
    entity: 'workflow_instance',
    entityId: row.id,
    event: 'workflow.created',
    actorKind: 'system',
    detail: {
      workflowType: row.workflow_type,
      subjectEntity: row.subject_entity,
      subjectEntityId: row.subject_entity_id,
      initialState: row.current_state,
    },
  });
  return toRow(row);
}

export async function getWorkflowInstance(
  client: pg.PoolClient,
  workflowInstanceId: string,
): Promise<WorkflowInstanceRow | null> {
  const result = await client.query<RawRow>(
    `SELECT id, client_id, workflow_type, subject_entity, subject_entity_id, current_state, created_at, updated_at
     FROM workflow_instance WHERE id = $1`,
    [workflowInstanceId],
  );
  const row = result.rows[0];
  return row ? toRow(row) : null;
}

interface RawRow {
  id: string;
  client_id: string;
  workflow_type: string;
  subject_entity: string;
  subject_entity_id: string;
  current_state: string;
  created_at: Date;
  updated_at: Date;
}

function toRow(row: RawRow): WorkflowInstanceRow {
  return {
    id: row.id,
    clientId: row.client_id,
    workflowType: row.workflow_type,
    subjectEntity: row.subject_entity,
    subjectEntityId: row.subject_entity_id,
    currentState: row.current_state,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
