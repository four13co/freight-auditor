import type pg from 'pg';
import { completeOutboxMessage } from '../modules/workflow/workflow-outbox.js';
import { parseJobPayload, JOB_NAMES, type JobPayloads } from './contracts.js';
import { createJobDispatcher } from './job-dispatcher.js';

export type OutboxMessageSender = (
  client: pg.PoolClient,
  ctx: {
    clientId: string;
    workflowInstanceId: string;
    commandId: string;
    outboxMessageId: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  },
) => Promise<void>;

export class UnregisteredOutboxMessageTypeError extends Error {
  constructor(readonly messageType: string) {
    super(`no sender registered for outbox message type: ${messageType}`);
    this.name = 'UnregisteredOutboxMessageTypeError';
  }
}

type DeliverOutboxMessagePayload = JobPayloads[typeof JOB_NAMES.DELIVER_OUTBOX_MESSAGE_V1];

/**
 * messageType -> sender registry, owned by the shared job-dispatcher factory
 * (job-dispatcher.ts) rather than reimplemented here -- the same factory
 * run-workflow-command-handler.ts's commandType -> handler registry
 * configures. Empty by default: no concrete outbox message type exists yet
 * (message_type is open text, same "no live caller wired in" state
 * 0063/P4.A.5 shipped with -- concrete types land with whatever future phase
 * first needs a real external effect). A future sender calls
 * registerOutboxMessageSender once at its own module's load time; this file
 * owns messageType -> sender wiring, never any specific message's send.
 */
const { registry: senders, register, dispatch } = createJobDispatcher<
  DeliverOutboxMessagePayload,
  Parameters<OutboxMessageSender>[1],
  DeliverOutboxMessageDeps
>({
  getTypeKey: (payload) => payload.messageType,
  getRegistry: (deps) => deps.senders,
  buildCtx: (payload) => ({
    clientId: payload.clientId,
    workflowInstanceId: payload.workflowInstanceId,
    commandId: payload.commandId,
    outboxMessageId: payload.outboxMessageId,
    idempotencyKey: payload.idempotencyKey,
    payload: payload.payload,
  }),
  complete: (deps, client, payload) => deps.complete(client, { clientId: payload.clientId, outboxMessageId: payload.outboxMessageId }),
  buildAuditEvent: (payload) => ({
    entity: 'workflow_outbox_message',
    entityId: payload.outboxMessageId,
    event: 'workflow.outbox_message_sent',
    detail: {
      workflowInstanceId: payload.workflowInstanceId,
      commandId: payload.commandId,
      messageType: payload.messageType,
    },
  }),
  createError: (typeKey) => new UnregisteredOutboxMessageTypeError(typeKey),
});

export function registerOutboxMessageSender(messageType: string, sender: OutboxMessageSender): void {
  register(messageType, sender);
}

export interface DeliverOutboxMessageDeps {
  senders: Map<string, OutboxMessageSender>;
  complete: typeof completeOutboxMessage;
}

const defaultDeps: DeliverOutboxMessageDeps = { senders, complete: completeOutboxMessage };

/**
 * Executes one already-claimed workflow_outbox_message (P4.A.5) by
 * dispatching to the sender registered for its messageType, then marks it
 * delivered. Called from inside the caller's tenant-scoped transaction
 * (boss.ts wires withTenantTx around this the same way it does for
 * RUN_WORKFLOW_COMMAND_V1), so a thrown error rolls back anything the
 * sender wrote in this attempt.
 *
 * Fail-safe by construction: an unregistered messageType throws
 * UnregisteredOutboxMessageTypeError BEFORE the sender runs and BEFORE
 * completeOutboxMessage is called -- the message stays 'claimed', pg-boss
 * retries per the queue's retry policy, and it eventually dead-letters
 * rather than silently vanishing or false-completing.
 *
 * The `idempotencyKey` passed to the sender is the message's own
 * dedupeKey -- stable across every attempt, unlike a job id derived from
 * attempts. This IS this task's own idempotency-key guarantee: a sender
 * wrapping a real external call (an HTTP request to a carrier, a payment
 * provider, etc.) passes this value straight through as that provider's
 * own idempotency-key mechanism (Stripe-style Idempotency-Key header, or
 * equivalent), so a retry after a crash between the sender's own call and
 * this function's completeOutboxMessage is recognized downstream as the
 * same operation rather than a second, duplicate external effect.
 *
 * At-least-once semantics only, same as run-workflow-command-handler.ts: a
 * crash between a successful sender call and the completeOutboxMessage
 * write means a retry re-runs the sender -- safe exactly because of the
 * idempotencyKey guarantee above, not because of anything transactional
 * (the external call itself is never rolled back by a DB rollback).
 */
export async function handleDeliverOutboxMessageJob(
  client: pg.PoolClient,
  untrustedPayload: unknown,
  deps: DeliverOutboxMessageDeps = defaultDeps,
): Promise<void> {
  const payload = parseJobPayload(JOB_NAMES.DELIVER_OUTBOX_MESSAGE_V1, untrustedPayload);
  await dispatch(client, payload, deps);
}
