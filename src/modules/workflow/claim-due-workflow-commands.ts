import type pg from 'pg';
import { z } from 'zod';

const schema = z.object({
  clientId: z.uuid(),
  now: z.date().default(() => new Date()),
  limit: z.number().int().positive().max(100).default(20),
}).strict();

export interface ClaimedWorkflowCommand {
  commandId: string;
  workflowInstanceId: string;
  commandType: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/**
 * Atomically claim due commands (run_after <= now(), status='pending') by
 * flipping them to 'claimed' and returning the rows in one statement, so
 * two concurrent workers can never both claim the same command -- the
 * UPDATE...RETURNING is the compare-and-set. Ordered by run_after so the
 * oldest deadline is served first.
 *
 * This is the due-query half of P4.A.3's scope boundary: it hands back
 * claimed rows for a caller to act on and later mark done (see
 * completeWorkflowCommand); the actual runner loop invoking this on a
 * schedule is P4.A.4, not built here.
 *
 * claimed_at records the moment of this flip so reclaimStaleWorkflowCommands
 * (P4.A.7) can later find a row that has sat 'claimed' longer than a worker
 * crash should plausibly explain.
 */
export async function claimDueWorkflowCommands(
  client: pg.PoolClient,
  untrusted: z.input<typeof schema>,
): Promise<ClaimedWorkflowCommand[]> {
  const input = schema.parse(untrusted);

  const result = await client.query<{
    id: string;
    workflow_instance_id: string;
    command_type: string;
    payload: Record<string, unknown>;
    attempts: number;
  }>(
    `UPDATE workflow_command
     SET status = 'claimed', attempts = attempts + 1, claimed_at = $2
     WHERE id IN (
       SELECT id FROM workflow_command
       WHERE client_id = $1 AND status = 'pending' AND run_after <= $2
       ORDER BY run_after
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, workflow_instance_id, command_type, payload, attempts`,
    [input.clientId, input.now.toISOString(), input.limit],
  );

  return result.rows.map((row) => ({
    commandId: row.id,
    workflowInstanceId: row.workflow_instance_id,
    commandType: row.command_type,
    payload: row.payload,
    attempts: row.attempts,
  }));
}

const completeSchema = z.object({
  clientId: z.uuid(),
  commandId: z.uuid(),
}).strict();

export interface CompleteWorkflowCommandResult {
  found: boolean;
}

/** Marks a claimed command done. Same-state (already 'done') is a no-op success -- an idempotent retry after a crash between claim and completion. */
export async function completeWorkflowCommand(
  client: pg.PoolClient,
  untrusted: z.input<typeof completeSchema>,
): Promise<CompleteWorkflowCommandResult> {
  const input = completeSchema.parse(untrusted);

  const result = await client.query(
    `UPDATE workflow_command SET status = 'done'
     WHERE client_id = $1 AND id = $2 AND status IN ('claimed', 'done')`,
    [input.clientId, input.commandId],
  );

  return { found: (result.rowCount ?? 0) > 0 };
}
