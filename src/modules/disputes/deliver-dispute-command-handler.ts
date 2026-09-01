import { registerWorkflowCommandHandler, type WorkflowCommandHandler } from '../../jobs/run-workflow-command-handler.js';
import { recordOutboxMessage } from '../workflow/workflow-outbox.js';
import { recordDisputeCommunication } from './record-dispute-communication.js';

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
 * P4.C.8: the outbound half of the dispute communications log. Deliberately
 * a *separate* dedupe key from disputeDeliveryDedupeKey -- that key
 * identifies the workflow_outbox_message (the delivery *decision*, P4.A.5);
 * this one identifies the dispute_comm row (the communications *record*,
 * P4.C.8). They happen to be recorded by the same handler call today, but
 * are two distinct append-only facts with two distinct idempotency scopes.
 */
export function disputeCommOutboundDedupeKey(disputeId: string): string {
  return `dispute-comm-outbound:${disputeId}`;
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
 *
 * Also appends the outbound half of the communications log (P4.C.8,
 * recordDisputeCommunication) in the same transaction, so the log entry
 * commits or rolls back atomically with the delivery decision itself --
 * a handler re-run after a crash before commit derives the same dedupe key
 * both times and gets the existing row back on the retry, not a duplicate.
 * The inbound half has no automatic trigger yet (no inbound carrier channel
 * exists, same "no live caller wired in" boundary DISPUTE_DELIVERY_MESSAGE_TYPE
 * itself documents) -- recordDisputeCommunication's own direction parameter
 * is what a future analyst-facing "log a reply" action calls directly.
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

  await recordDisputeCommunication(client, {
    disputeId,
    direction: 'outbound',
    body: `Delivery to carrier initiated for dispute ${disputeId}.`,
    dedupeKey: disputeCommOutboundDedupeKey(disputeId),
  });
};

registerWorkflowCommandHandler(DELIVER_DISPUTE_COMMAND_TYPE, handleDeliverDisputeCommand);
