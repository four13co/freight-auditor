import type pg from 'pg';
import { z } from 'zod';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';

const schema = z.object({
  clientId: z.uuid(),
  workflowInstanceId: z.uuid(),
  commandType: z.string().regex(/^[a-z][a-z0-9_]*$/),
  payload: z.record(z.string(), z.unknown()).default({}),
  runAfter: z.date(),
}).strict();

export interface ScheduleWorkflowCommandResult {
  commandId: string;
  created: boolean;
}

export class ScheduleWorkflowCommandError extends Error {
  constructor(readonly code: 'INSTANCE_NOT_FOUND') {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'ScheduleWorkflowCommandError';
  }
}

/**
 * Persist a resumable command against a workflow_instance (P4.A.3): a
 * durable row for "do commandType to this instance at runAfter, exactly
 * once, even across a worker crash." The row surviving IS the
 * resumability -- nothing about the command lives in memory. This function
 * only persists; claiming/running due commands is claimDueWorkflowCommands
 * below, and an actual runner loop is P4.A.4 (not built here).
 *
 * Idempotent per (workflowInstanceId, commandType, runAfter): a caller that
 * re-derives the same deadline for the same command on retry gets the
 * existing row back rather than a duplicate pending command.
 */
export async function scheduleWorkflowCommand(
  client: pg.PoolClient,
  untrusted: z.input<typeof schema>,
): Promise<ScheduleWorkflowCommandResult> {
  const input = schema.parse(untrusted);

  const instance = await client.query(
    `SELECT 1 FROM workflow_instance WHERE client_id = $1 AND id = $2`,
    [input.clientId, input.workflowInstanceId],
  );
  if (!instance.rowCount) throw new ScheduleWorkflowCommandError('INSTANCE_NOT_FOUND');

  const existing = await client.query<{ id: string }>(
    `SELECT id FROM workflow_command
     WHERE client_id = $1 AND workflow_instance_id = $2 AND command_type = $3
       AND run_after = $4 AND status = 'pending'`,
    [input.clientId, input.workflowInstanceId, input.commandType, input.runAfter.toISOString()],
  );
  const existingId = existing.rows[0]?.id;
  if (existingId) return { commandId: existingId, created: false };

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO workflow_command (client_id, workflow_instance_id, command_type, payload, run_after)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING id`,
    [input.clientId, input.workflowInstanceId, input.commandType, JSON.stringify(input.payload), input.runAfter.toISOString()],
  );
  const commandId = inserted.rows[0]!.id;

  await writeAuditEvent(client, {
    id: deterministicAuditEventId(input.clientId, commandId, 'workflow.command_scheduled'),
    clientId: input.clientId,
    entity: 'workflow_command',
    entityId: commandId,
    event: 'workflow.command_scheduled',
    actorKind: 'system',
    detail: {
      workflowInstanceId: input.workflowInstanceId,
      commandType: input.commandType,
      runAfter: input.runAfter.toISOString(),
    },
  });

  return { commandId, created: true };
}
