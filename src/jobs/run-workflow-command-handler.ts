import type pg from 'pg';
import { completeWorkflowCommand } from '../modules/workflow/claim-due-workflow-commands.js';
import { deterministicAuditEventId, writeAuditEvent } from '../modules/audit-ledger/write-audit-event.js';
import { parseJobPayload, JOB_NAMES } from './contracts.js';

export type WorkflowCommandHandler = (
  client: pg.PoolClient,
  ctx: { clientId: string; workflowInstanceId: string; commandType: string; payload: Record<string, unknown> },
) => Promise<void>;

export class UnknownWorkflowCommandTypeError extends Error {
  constructor(readonly commandType: string) {
    super(`no handler registered for workflow command type: ${commandType}`);
    this.name = 'UnknownWorkflowCommandTypeError';
  }
}

/**
 * commandType -> handler registry. Empty by default: no concrete
 * workflow_command types exist yet (0053/P4.A.3's own header comment --
 * command_type is open text, concrete types land with their owning phase,
 * same design as workflow_instance.workflow_type/current_state in 0046). A
 * future phase that introduces a command type calls
 * registerWorkflowCommandHandler once at its own module's load time; this
 * file owns dispatch and completion, never any specific command's effect.
 */
const handlers = new Map<string, WorkflowCommandHandler>();

export function registerWorkflowCommandHandler(commandType: string, handler: WorkflowCommandHandler): void {
  handlers.set(commandType, handler);
}

export interface RunWorkflowCommandDeps {
  handlers: Map<string, WorkflowCommandHandler>;
  complete: typeof completeWorkflowCommand;
}

const defaultDeps: RunWorkflowCommandDeps = { handlers, complete: completeWorkflowCommand };

/**
 * Executes one already-claimed workflow_command (P4.A.3) by dispatching to
 * the handler registered for its commandType, then marks it done. Called
 * from inside the caller's tenant-scoped transaction (boss.ts wires
 * withTenantTx around this the same way it does for
 * FOLLOW_UP_CLAIM_V1/ESCALATE_CLAIM_V1), so a thrown error rolls back
 * anything the handler wrote in this attempt.
 *
 * Fail-safe by construction: an unregistered commandType throws
 * UnknownWorkflowCommandTypeError BEFORE the handler runs and BEFORE
 * completeWorkflowCommand is called -- the command stays 'claimed', pg-boss
 * retries per the queue's retry policy, and it eventually dead-letters
 * rather than silently vanishing or false-completing. This is exactly the
 * "unable to activate rules ... unless explicitly human-gated" boundary:
 * with no handlers registered yet, nothing this runner dispatches can have
 * any effect. A handler that itself throws propagates the same way --
 * claimed, not completed, retried.
 *
 * At-least-once semantics only: a crash between a successful handler call
 * and the completeWorkflowCommand write means a retry re-runs the handler.
 * Exactly-once/transactional outbox delivery is P4.A.5, out of this task's
 * boundary (the same exclusion claim-due-workflow-commands.ts's own header
 * comment already documents for this file).
 */
export async function handleRunWorkflowCommandJob(
  client: pg.PoolClient,
  untrustedPayload: unknown,
  deps: RunWorkflowCommandDeps = defaultDeps,
): Promise<void> {
  const payload = parseJobPayload(JOB_NAMES.RUN_WORKFLOW_COMMAND_V1, untrustedPayload);

  const handler = deps.handlers.get(payload.commandType);
  if (!handler) throw new UnknownWorkflowCommandTypeError(payload.commandType);

  await handler(client, {
    clientId: payload.clientId,
    workflowInstanceId: payload.workflowInstanceId,
    commandType: payload.commandType,
    payload: payload.payload,
  });

  await deps.complete(client, { clientId: payload.clientId, commandId: payload.commandId });

  await writeAuditEvent(client, {
    id: deterministicAuditEventId(payload.clientId, payload.commandId, 'workflow.command_run'),
    clientId: payload.clientId,
    entity: 'workflow_command',
    entityId: payload.commandId,
    event: 'workflow.command_run',
    actorKind: 'system',
    detail: { workflowInstanceId: payload.workflowInstanceId, commandType: payload.commandType },
  });
}
