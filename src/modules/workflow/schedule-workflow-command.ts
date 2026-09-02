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
 * existing row back rather than a duplicate pending command. Backed by a
 * real DB constraint (migration 0072, workflow_command_dedupe_key) via
 * INSERT ... ON CONFLICT DO NOTHING, mirroring recordOutboxMessage's own
 * idempotent-insert shape -- an app-level SELECT-then-INSERT alone cannot
 * stop two concurrent callers from both passing the check.
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

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO workflow_command (client_id, workflow_instance_id, command_type, payload, run_after)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (client_id, workflow_instance_id, command_type, run_after) DO NOTHING
     RETURNING id`,
    [input.clientId, input.workflowInstanceId, input.commandType, JSON.stringify(input.payload), input.runAfter.toISOString()],
  );

  if (inserted.rows[0]) {
    const commandId = inserted.rows[0].id;
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

  const existing = await client.query<{ id: string }>(
    `SELECT id FROM workflow_command
     WHERE client_id = $1 AND workflow_instance_id = $2 AND command_type = $3 AND run_after = $4`,
    [input.clientId, input.workflowInstanceId, input.commandType, input.runAfter.toISOString()],
  );
  return { commandId: existing.rows[0]!.id, created: false };
}
