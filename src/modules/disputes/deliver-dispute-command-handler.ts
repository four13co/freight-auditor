import { registerWorkflowCommandHandler, type WorkflowCommandHandler } from '../../jobs/run-workflow-command-handler.js';
import { recordOutboxMessage } from '../workflow/workflow-outbox.js';

export const DELIVER_DISPUTE_COMMAND_TYPE = 'deliver_dispute';

/**
 * The messageType a future concrete carrier-contact sender registers for
 * via registerOutboxMessageSender (deliver-outbox-message-handler.ts) --
 * the named, injected seam this task's own Exclusions section draws the
 * line at ("No direct AI activation, unaudited outbound delivery"). No
 * such sender is registered anywhere in this repo yet: no email/EDI/SFTP
 * channel to an actual carrier exists (the SFTP job queues registered
 * elsewhere have no consumer), and inventing a default that silently marks
 * a dispute "delivered" would misrepresent that an external effect
 * happened when it didn't. Until a future phase registers a real sender,
 * a claimed message of this type dead-letters after retries rather than
 * silently vanishing or false-completing -- the same fail-safe shape
 * UnregisteredOutboxMessageTypeError already gives any unregistered type.
 */
export const DISPUTE_DELIVERY_MESSAGE_TYPE = 'dispute_delivery';

/** Stable per-dispute key: approveDispute's own `WHERE status = 'draft'` guard means at most one deliver_dispute command is ever scheduled per dispute, so this alone is enough to dedupe a handler re-run after a crash. */
export function disputeDeliveryDedupeKey(disputeId: string): string {
  return `dispute-delivery:${disputeId}`;
}

/**
 * Handles the deliver_dispute workflow_command (P4.C.7) that approveDispute
 * schedules on draft -> sent. Records an outbound-delivery intent via
 * recordOutboxMessage (P4.A.5) inside this same transaction rather than
 * calling out to a carrier directly -- that's what makes the *decision* to
 * deliver exactly-once, per run-workflow-command-handler.ts's own docstring.
 * Actually sending is a separate, later, idempotent step
 * (deliver-outbox-message-handler.ts) against DISPUTE_DELIVERY_MESSAGE_TYPE's
 * sender -- not registered yet, see that constant's own doc comment.
 */
export const handleDeliverDisputeCommand: WorkflowCommandHandler = async (client, ctx) => {
  const disputeId = ctx.payload.disputeId;
  if (typeof disputeId !== 'string' || disputeId.length === 0) {
    throw new Error(`deliver_dispute command payload missing disputeId (commandId=${ctx.commandId})`);
  }

  await recordOutboxMessage(client, {
    clientId: ctx.clientId,
    workflowInstanceId: ctx.workflowInstanceId,
    commandId: ctx.commandId,
    dedupeKey: disputeDeliveryDedupeKey(disputeId),
    payload: { disputeId },
    messageType: DISPUTE_DELIVERY_MESSAGE_TYPE,
  });
};

registerWorkflowCommandHandler(DELIVER_DISPUTE_COMMAND_TYPE, handleDeliverDisputeCommand);
