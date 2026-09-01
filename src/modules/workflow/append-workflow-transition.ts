import type pg from 'pg';
import { z } from 'zod';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';
import { validateWorkflowTransition, type WorkflowTransitionMap } from './validate-workflow-transition.js';

const schema = z.object({
  clientId: z.uuid(),
  workflowInstanceId: z.uuid(),
  toState: z.string().min(1),
}).strict();

export interface AppendWorkflowTransitionResult {
  /** false when the instance doesn't exist / isn't visible under RLS for this tenant. */
  found: boolean;
}

export class AppendWorkflowTransitionError extends Error {
  constructor(readonly code: 'INSTANCE_NOT_FOUND') {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'AppendWorkflowTransitionError';
  }
}

/**
 * Transition a workflow_instance's current_state and append the immutable
 * transition record in one statement (P4.A.2), mirroring
 * update-finding-status.ts's CTE shape: the `old` CTE captures the
 * pre-transition state in the same statement as the UPDATE, so the mutable
 * current-state row and its append-only history never diverge.
 *
 * The pre-check below takes `FOR UPDATE` on the workflow_instance row, so it
 * holds a row-level lock for the rest of this transaction. A second call
 * racing against the same instance blocks on that lock until this one
 * commits or rolls back, then re-reads the (now current) state itself --
 * closing the read-then-write TOCTOU gap a plain SELECT would leave (see PR
 * #228's review finding: the atomic CTE's own `old` re-read was a second,
 * unlocked snapshot, so a losing caller could log a from/to pair it never
 * validated). Legality is still checked against allowedTransitions BEFORE
 * any write -- workflow_instance.current_state and workflow_type are open
 * text (0046), so the caller supplies the transition map for its own
 * workflow_type; this function has no hardcoded state graph. A same-state
 * call is always legal (validateWorkflowTransition's own idempotent-retry
 * rule) and still appends a transition row -- the append-only log records
 * that the retry happened, it does not suppress it.
 *
 * The UPDATE touches ONLY current_state and updated_at, matching
 * workflow_instance's actual grant (0046: GRANT SELECT, INSERT, UPDATE,
 * DELETE -- full-table, not column-restricted, so this is a self-imposed
 * discipline rather than an enforced one).
 */
export async function appendWorkflowTransition(
  client: pg.PoolClient,
  untrusted: z.input<typeof schema>,
  allowedTransitions: WorkflowTransitionMap,
): Promise<AppendWorkflowTransitionResult> {
  const input = schema.parse(untrusted);

  const current = await client.query<{ client_id: string; current_state: string }>(
    `SELECT client_id, current_state FROM workflow_instance WHERE client_id = $1 AND id = $2 FOR UPDATE`,
    [input.clientId, input.workflowInstanceId],
  );
  const instance = current.rows[0];
  if (!instance) throw new AppendWorkflowTransitionError('INSTANCE_NOT_FOUND');

  validateWorkflowTransition(instance.current_state, input.toState, allowedTransitions);

  const result = await client.query<{ id: string; client_id: string; from_state: string; transition_id: string }>(
    `WITH old AS (
       SELECT id, client_id, current_state AS from_state FROM workflow_instance WHERE client_id = $1 AND id = $2
     ),
     updated AS (
       UPDATE workflow_instance
       SET current_state = $3, updated_at = now()
       WHERE id = (SELECT id FROM old)
       RETURNING id, client_id
     ),
     logged AS (
       INSERT INTO workflow_transition (client_id, workflow_instance_id, from_state, to_state)
       SELECT updated.client_id, updated.id, old.from_state, $3
       FROM updated JOIN old ON true
       RETURNING id
     )
     SELECT updated.id, updated.client_id, (SELECT from_state FROM old) AS from_state,
       (SELECT id FROM logged) AS transition_id
     FROM updated`,
    [input.clientId, input.workflowInstanceId, input.toState],
  );

  const row = result.rows[0];
  if (!row) return { found: false };

  await writeAuditEvent(client, {
    id: deterministicAuditEventId(row.client_id, row.transition_id, 'workflow.transitioned'),
    clientId: row.client_id,
    entity: 'workflow_instance',
    entityId: row.id,
    event: 'workflow.transitioned',
    actorKind: 'system',
    detail: { fromState: row.from_state, toState: input.toState, transitionId: row.transition_id },
  });
  return { found: true };
}
