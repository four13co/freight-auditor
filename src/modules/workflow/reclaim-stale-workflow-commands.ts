import type pg from 'pg';
import { z } from 'zod';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';

const schema = z.object({
  clientId: z.uuid(),
  now: z.date().default(() => new Date()),
  staleAfterMinutes: z.number().int().positive().default(30),
  maxAttempts: z.number().int().positive().default(5),
  limit: z.number().int().positive().max(100).default(20),
}).strict();

export interface ReclaimedWorkflowCommand {
  commandId: string;
  workflowInstanceId: string;
  attempts: number;
  outcome: 'reclaimed' | 'failed';
}

/**
 * Recovers workflow_command rows stranded in 'claimed' by a worker/process
 * that crashed (or a job that permanently failed) before completeWorkflow-
 * Command ever ran -- P4.A.4's own docstring (schedule-workflow-command-
 * jobs.ts) names this exact gap and defers it here.
 *
 * A row claimed more than staleAfterMinutes ago is recovered one of two
 * ways: back to 'pending' (claimed_at cleared) for a fresh claim if attempts
 * is still under maxAttempts, or to a terminal 'failed' state once
 * exhausted -- so a permanently-stuck command becomes a visible, auditable
 * dead end instead of an invisible stalled row (workflow_command_due_idx is
 * WHERE status='pending', so a stranded 'claimed' row is invisible to every
 * pre-existing query).
 *
 * staleAfterMinutes defaults comfortably above this queue's own pg-boss
 * retry budget (policies.ts: expireInMinutes 15, retryLimit 5 @ retryDelay
 * 30s backoff) so pg-boss's own retry gets first chance to resume a merely-
 * slow job before this reclaims the row out from under a still-in-flight
 * retry.
 *
 * Same UPDATE...RETURNING FOR UPDATE SKIP LOCKED compare-and-set shape as
 * claimDueWorkflowCommands, so two concurrent scans can never both recover
 * the same row.
 */
export async function reclaimStaleWorkflowCommands(
  client: pg.PoolClient,
  untrusted: z.input<typeof schema>,
): Promise<ReclaimedWorkflowCommand[]> {
  const input = schema.parse(untrusted);
  const cutoff = new Date(input.now.getTime() - input.staleAfterMinutes * 60_000);

  const result = await client.query<{
    id: string;
    workflow_instance_id: string;
    attempts: number;
    status: string;
  }>(
    `UPDATE workflow_command
     SET status = CASE WHEN attempts >= $4 THEN 'failed' ELSE 'pending' END,
         claimed_at = NULL
     WHERE id IN (
       SELECT id FROM workflow_command
       WHERE client_id = $1 AND status = 'claimed' AND claimed_at <= $2
       ORDER BY claimed_at
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, workflow_instance_id, attempts, status`,
    [input.clientId, cutoff.toISOString(), input.limit, input.maxAttempts],
  );

  return result.rows.map((row) => ({
    commandId: row.id,
    workflowInstanceId: row.workflow_instance_id,
    attempts: row.attempts,
    outcome: row.status === 'failed' ? 'failed' : 'reclaimed',
  }));
}

export interface ReclaimStaleWorkflowCommandsResult {
  reclaimed: number;
  failed: number;
}

/**
 * Portfolio-wide tick: recovers stale claims for every active client and
 * records one audit event per row recovered, mirroring
 * scheduleWorkflowCommandJobs's own per-client iteration. Meant to run from
 * the same internal (cross-tenant) transaction as that scan, immediately
 * before it, so a row recovered back to 'pending' this tick is visible to
 * the due-query claim that follows in the same transaction.
 */
export async function reclaimStaleWorkflowCommandsForActiveClients(
  client: pg.PoolClient,
  now: Date = new Date(),
): Promise<ReclaimStaleWorkflowCommandsResult> {
  const clients = await client.query<{ id: string }>(
    `SELECT id FROM client WHERE is_active = true`,
  );

  let reclaimed = 0;
  let failed = 0;

  for (const { id: clientId } of clients.rows) {
    const rows = await reclaimStaleWorkflowCommands(client, { clientId, now });
    for (const row of rows) {
      if (row.outcome === 'failed') failed += 1;
      else reclaimed += 1;

      const event = row.outcome === 'failed' ? 'workflow.command_failed' : 'workflow.command_reclaimed';
      await writeAuditEvent(client, {
        id: deterministicAuditEventId(clientId, row.commandId, event, String(row.attempts)),
        clientId,
        entity: 'workflow_command',
        entityId: row.commandId,
        event,
        actorKind: 'system',
        detail: { workflowInstanceId: row.workflowInstanceId, attempts: row.attempts },
      });
    }
  }

  return { reclaimed, failed };
}
