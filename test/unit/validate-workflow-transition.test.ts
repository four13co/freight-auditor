import { describe, it, expect } from 'vitest';
import {
  validateWorkflowTransition,
  WorkflowTransitionError,
  type WorkflowTransitionMap,
} from '../../src/modules/workflow/validate-workflow-transition.js';

const disputeTransitions: WorkflowTransitionMap = {
  draft: ['sent'],
  sent: ['in_progress', 'accepted', 'rejected'],
  in_progress: ['accepted', 'rejected'],
};

describe('validateWorkflowTransition', () => {
  it('allows a transition listed in the map', () => {
    expect(() => validateWorkflowTransition('draft', 'sent', disputeTransitions)).not.toThrow();
  });

  it('allows a same-state transition even for an unknown state (idempotent retry)', () => {
    expect(() => validateWorkflowTransition('closed', 'closed', disputeTransitions)).not.toThrow();
  });

  it('rejects a transition from a state not present in the map', () => {
    try {
      validateWorkflowTransition('closed', 'sent', disputeTransitions);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowTransitionError);
      expect((err as WorkflowTransitionError).code).toBe('UNKNOWN_FROM_STATE');
    }
  });

  it('rejects a transition not listed for a known from-state', () => {
    try {
      validateWorkflowTransition('draft', 'accepted', disputeTransitions);
      expect.unreachable();
    } catch (err) {
      expect((err as WorkflowTransitionError).code).toBe('ILLEGAL_TRANSITION');
    }
  });

  it('rejects any transition when the map is empty, except same-state', () => {
    try {
      validateWorkflowTransition('draft', 'sent', {});
      expect.unreachable();
    } catch (err) {
      expect((err as WorkflowTransitionError).code).toBe('UNKNOWN_FROM_STATE');
    }
    expect(() => validateWorkflowTransition('draft', 'draft', {})).not.toThrow();
  });
});
