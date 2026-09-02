import type pg from 'pg';
import { completeWorkflowCommand } from '../modules/workflow/claim-due-workflow-commands.js';
import { parseJobPayload, JOB_NAMES, type JobPayloads } from './contracts.js';
import { createJobDispatcher } from './job-dispatcher.js';

export type WorkflowCommandHandler = (
  client: pg.PoolClient,
  ctx: { clientId: string; workflowInstanceId: string; commandId: string; commandType: string; payload: Record<string, unknown> },
) => Promise<void>;

export class UnknownWorkflowCommandTypeError extends Error {
  constructor(readonly commandType: string) {
    super(`no handler registered for workflow command type: ${commandType}`);
    this.name = 'UnknownWorkflowCommandTypeError';
  }
}

type RunWorkflowCommandPayload = JobPayloads[typeof JOB_NAMES.RUN_WORKFLOW_COMMAND_V1];

/**
 * commandType -> handler registry, owned by the shared job-dispatcher
 * factory (job-dispatcher.ts) rather than reimplemented here. Empty by
 * default: no concrete workflow_command types exist yet (0053/P4.A.3's own
 * header comment -- command_type is open text, concrete types land with
 * their owning phase, same design as
 * workflow_instance.workflow_type/current_state in 0046). A future phase
 * that introduces a command type calls registerWorkflowCommandHandler once
 * at its own module's load time; this file owns commandType -> handler
 * wiring, never any specific command's effect.
 */
const { registry: handlers, register, dispatch } = createJobDispatcher<
  RunWorkflowCommandPayload,
  Parameters<WorkflowCommandHandler>[1],
  RunWorkflowCommandDeps
>({
  getTypeKey: (payload) => payload.commandType,
  getRegistry: (deps) => deps.handlers,
  buildCtx: (payload) => ({
    clientId: payload.clientId,
    workflowInstanceId: payload.workflowInstanceId,
    commandId: payload.commandId,
    commandType: payload.commandType,
    payload: payload.payload,
  }),
  complete: (deps, client, payload) => deps.complete(client, { clientId: payload.clientId, commandId: payload.commandId }),
  buildAuditEvent: (payload) => ({
    entity: 'workflow_command',
    entityId: payload.commandId,
    event: 'workflow.command_run',
    detail: { workflowInstanceId: payload.workflowInstanceId, commandType: payload.commandType },
  }),
  createError: (typeKey) => new UnknownWorkflowCommandTypeError(typeKey),
});

export function registerWorkflowCommandHandler(commandType: string, handler: WorkflowCommandHandler): void {
  register(commandType, handler);
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
 * and the completeWorkflowCommand write means a retry re-runs the handler --
 * safe for a handler whose only effects are DB writes made with this same
 * `client` (the whole attempt rolls back together), but NOT safe for a
 * handler that calls out to an external system directly, since that call
 * isn't rolled back by a DB rollback. A handler needing an external effect
 * should call recordOutboxMessage (workflow-outbox.ts, P4.A.5) with this
 * same `client` instead of calling out inline -- the durable delivery
 * intent then commits or rolls back exactly with this function's own
 * complete() call, and a separate, later, idempotent step (not built here)
 * performs the actual send against the committed row.
 *
 * ctx carries commandId (P4.C.7) so a handler can call recordOutboxMessage,
 * whose own FK guard (`workflow_command WHERE client_id = $1 AND id = $2`)
 * requires it -- nothing before this task's first live handler ever needed
 * it in ctx.
 */
export async function handleRunWorkflowCommandJob(
  client: pg.PoolClient,
  untrustedPayload: unknown,
  deps: RunWorkflowCommandDeps = defaultDeps,
): Promise<void> {
  const payload = parseJobPayload(JOB_NAMES.RUN_WORKFLOW_COMMAND_V1, untrustedPayload);
  await dispatch(client, payload, deps);
}
