import type pg from 'pg';
import { z } from 'zod';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';

const recordSchema = z.object({
  clientId: z.uuid(),
  workflowInstanceId: z.uuid(),
  commandId: z.uuid(),
  dedupeKey: z.string().trim().min(1).max(255),
  payload: z.record(z.string(), z.unknown()).default({}),
  // Dispatch discriminator for the future deliverer (P4.A.6), mirroring
  // workflow_command's own command_type (0053). Defaults to 'unspecified'
  // so every existing call site (none of which pass this yet -- "no live
  // caller wired in" per P4.A.5) keeps working unchanged.
  messageType: z.string().trim().regex(/^[a-z][a-z0-9_]*$/).default('unspecified'),
}).strict();

export interface RecordOutboxMessageResult {
  outboxMessageId: string;
  created: boolean;
}

export class RecordOutboxMessageError extends Error {
  constructor(readonly code: 'COMMAND_NOT_FOUND') {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'RecordOutboxMessageError';
  }
}

/**
 * Record an outbound-delivery intent (P4.A.5) inside the caller's own
 * transaction, so it commits or rolls back together with whatever else that
 * transaction does -- typically completeWorkflowCommand, called with the
 * same `client` from inside a WorkflowCommandHandler (run-workflow-command-
 * handler.ts). This is what makes the *decision* to deliver exactly-once:
 * a handler that calls out to an external system directly has no such
 * guarantee (the call isn't rolled back by a DB rollback), which is exactly
 * the gap that file's own docstring names and defers to this task.
 *
 * Idempotent per (clientId, dedupeKey): a handler re-run after a crash
 * before its transaction ever committed derives the same dedupeKey and gets
 * the existing row back (created: false) instead of a second delivery
 * intent -- ON CONFLICT DO NOTHING, then a plain SELECT for the existing id,
 * mirroring scheduleWorkflowCommand's own idempotent-insert shape.
 *
 * Actually sending the message is a separate, later, idempotent step
 * (claimDueOutboxMessages / completeOutboxMessage below) that a future
 * concrete deliverer runs against the committed row -- this function only
 * persists the intent, matching workflow_command's own "persist + due-query
 * only" boundary (P4.A.3). No caller is wired in yet.
 */
export async function recordOutboxMessage(
  client: pg.PoolClient,
  untrusted: z.input<typeof recordSchema>,
): Promise<RecordOutboxMessageResult> {
  const input = recordSchema.parse(untrusted);

  const command = await client.query(
    `SELECT 1 FROM workflow_command WHERE client_id = $1 AND id = $2`,
    [input.clientId, input.commandId],
  );
  if (!command.rowCount) throw new RecordOutboxMessageError('COMMAND_NOT_FOUND');

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO workflow_outbox_message (client_id, workflow_instance_id, command_id, dedupe_key, payload, message_type)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (client_id, dedupe_key) DO NOTHING
     RETURNING id`,
    [input.clientId, input.workflowInstanceId, input.commandId, input.dedupeKey, JSON.stringify(input.payload), input.messageType],
  );

  if (inserted.rows[0]) {
    const outboxMessageId = inserted.rows[0].id;
    await writeAuditEvent(client, {
      id: deterministicAuditEventId(input.clientId, outboxMessageId, 'workflow.outbox_message_recorded'),
      clientId: input.clientId,
      entity: 'workflow_outbox_message',
      entityId: outboxMessageId,
      event: 'workflow.outbox_message_recorded',
      actorKind: 'system',
      detail: { workflowInstanceId: input.workflowInstanceId, commandId: input.commandId, dedupeKey: input.dedupeKey },
    });
    return { outboxMessageId, created: true };
  }

  const existing = await client.query<{ id: string }>(
    `SELECT id FROM workflow_outbox_message WHERE client_id = $1 AND dedupe_key = $2`,
    [input.clientId, input.dedupeKey],
  );
  return { outboxMessageId: existing.rows[0]!.id, created: false };
}

const claimSchema = z.object({
  clientId: z.uuid(),
  now: z.date().default(() => new Date()),
  limit: z.number().int().positive().max(100).default(20),
}).strict();

export interface ClaimedOutboxMessage {
  outboxMessageId: string;
  workflowInstanceId: string;
  commandId: string;
  dedupeKey: string;
  messageType: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/**
 * Atomically claim pending outbox messages by flipping them to 'claimed' and
 * returning the rows in one statement -- the UPDATE...RETURNING is the
 * compare-and-set, mirroring claimDueWorkflowCommands, so two concurrent
 * deliverers can never both claim the same message. FOR UPDATE SKIP LOCKED
 * lets concurrent claims proceed over disjoint rows rather than blocking on
 * each other. Ordered by created_at so the oldest message is served first.
 *
 * claimed_at records the moment of this flip so reclaimStaleOutboxMessages
 * (P4.A.8) can later find a row that has sat 'claimed' longer than a
 * delivery worker crash should plausibly explain -- the identical pattern
 * claimDueWorkflowCommands uses for reclaimStaleWorkflowCommands (P4.A.7).
 */
export async function claimDueOutboxMessages(
  client: pg.PoolClient,
  untrusted: z.input<typeof claimSchema>,
): Promise<ClaimedOutboxMessage[]> {
  const input = claimSchema.parse(untrusted);

  const result = await client.query<{
    id: string;
    workflow_instance_id: string;
    command_id: string;
    dedupe_key: string;
    message_type: string;
    payload: Record<string, unknown>;
    attempts: number;
  }>(
    `UPDATE workflow_outbox_message
     SET status = 'claimed', attempts = attempts + 1, claimed_at = $2
     WHERE id IN (
       SELECT id FROM workflow_outbox_message
       WHERE client_id = $1 AND status = 'pending' AND created_at <= $2
       ORDER BY created_at
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, workflow_instance_id, command_id, dedupe_key, message_type, payload, attempts`,
    [input.clientId, input.now.toISOString(), input.limit],
  );

  return result.rows.map((row) => ({
    outboxMessageId: row.id,
    workflowInstanceId: row.workflow_instance_id,
    commandId: row.command_id,
    dedupeKey: row.dedupe_key,
    messageType: row.message_type,
    payload: row.payload,
    attempts: row.attempts,
  }));
}

const completeSchema = z.object({
  clientId: z.uuid(),
  outboxMessageId: z.uuid(),
}).strict();

export interface CompleteOutboxMessageResult {
  found: boolean;
}

/** Marks a claimed outbox message delivered. Same-state (already 'delivered') is a no-op success -- an idempotent retry after a crash between claim and completion. */
export async function completeOutboxMessage(
  client: pg.PoolClient,
  untrusted: z.input<typeof completeSchema>,
): Promise<CompleteOutboxMessageResult> {
  const input = completeSchema.parse(untrusted);

  const result = await client.query(
    `UPDATE workflow_outbox_message SET status = 'delivered'
     WHERE client_id = $1 AND id = $2 AND status IN ('claimed', 'delivered')`,
    [input.clientId, input.outboxMessageId],
  );

  if (result.rowCount) {
    await writeAuditEvent(client, {
      id: deterministicAuditEventId(input.clientId, input.outboxMessageId, 'workflow.outbox_message_delivered'),
      clientId: input.clientId,
      entity: 'workflow_outbox_message',
      entityId: input.outboxMessageId,
      event: 'workflow.outbox_message_delivered',
      actorKind: 'system',
      detail: {},
    });
  }

  return { found: (result.rowCount ?? 0) > 0 };
}
