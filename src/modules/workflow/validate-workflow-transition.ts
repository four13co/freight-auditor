/**
 * Pure legal-transition check (P4.A.2). workflow_instance.current_state and
 * workflow_type are open text (see migrations/0046's header comment: concrete
 * state machines land with their owning phase, not as an enum here), so this
 * cannot hardcode a state graph -- the caller passes the allowed-transitions
 * map for its own workflow_type, and this only checks against it.
 *
 * A same-state "transition" (fromState === toState) is always legal: it is
 * the shape a retried/duplicate transition-append call takes (the caller
 * re-submits the same target state after a crash or timeout), and rejecting
 * it would make retries unsafe rather than idempotent.
 */
export interface WorkflowTransitionMap {
  [fromState: string]: readonly string[];
}

export class WorkflowTransitionError extends Error {
  constructor(readonly code: 'UNKNOWN_FROM_STATE' | 'ILLEGAL_TRANSITION') {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'WorkflowTransitionError';
  }
}

export function validateWorkflowTransition(
  fromState: string,
  toState: string,
  allowedTransitions: WorkflowTransitionMap,
): void {
  if (fromState === toState) return;

  const allowed = allowedTransitions[fromState];
  if (allowed === undefined) throw new WorkflowTransitionError('UNKNOWN_FROM_STATE');
  if (!allowed.includes(toState)) throw new WorkflowTransitionError('ILLEGAL_TRANSITION');
}
