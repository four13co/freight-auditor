import type pg from 'pg';
import type PgBoss from 'pg-boss';
import { enqueueInTransaction } from '../../jobs/enqueue.js';
import { JOB_NAMES } from '../../jobs/contracts.js';
import { claimDueWorkflowCommands } from './claim-due-workflow-commands.js';

export interface ScheduleWorkflowCommandJobsResult {
  enqueued: number;
}

/**
 * The pg-boss workflow runner's scan half (P4.A.4): for every active client,
 * atomically claims due workflow_command rows (claimDueWorkflowCommands --
 * the compare-and-set that keeps two concurrent scans from double-claiming)
 * and enqueues one RUN_WORKFLOW_COMMAND_V1 job per claimed command.
 *
 * Runs inside a single internal (cross-tenant) transaction, mirroring
 * scheduleClaimAgingJobs: claimDueWorkflowCommands trusts the caller to have
 * already scoped the query, so `client` here must come from
 * `withTenantTx({ internal: true }, ...)`.
 *
 * Each enqueue goes through enqueueInTransaction so the job insert commits
 * or rolls back with the same transaction that flipped the command to
 * 'claimed' -- if the transaction rolls back, the command reverts to
 * 'pending' and the job was never actually sent, so nothing is left claimed
 * with no corresponding job. The job id is derived from commandId alone (not
 * attempts): claimDueWorkflowCommands already prevents a second scan from
 * re-claiming a still-'claimed' row, so this is defense in depth, not the
 * primary duplicate guard.
 *
 * What happens if the claimed command's job never completes (worker crash,
 * permanent handler failure) is recovered by reclaimStaleWorkflowCommands-
 * ForActiveClients (P4.A.7), run from the same scan tick immediately before
 * this function (workflow-command-scan-handler.ts) -- a row it reclaims
 * back to 'pending' is claimed fresh here on this same tick or the next.
 *
 * The idempotencyKey below folds in `attempts` specifically so a reclaimed
 * command gets a job id distinct from its first (now dead/expired) attempt:
 * deterministicJobId is keyed only on (name, clientId, idempotencyKey), and
 * pg-boss's send() with an explicit id no-ops if a job with that id already
 * exists (retentionDays: 30 in policies.ts keeps the old row around) -- an
 * unqualified `workflow-command:${commandId}` key would silently swallow
 * every re-enqueue after a reclaim, leaving the row 'pending' forever with
 * no job ever actually running it again.
 */
export async function scheduleWorkflowCommandJobs(
  client: pg.PoolClient,
  boss: Pick<PgBoss, 'send'>,
  now: Date = new Date(),
): Promise<ScheduleWorkflowCommandJobsResult> {
  const clients = await client.query<{ id: string }>(
    `SELECT id FROM client WHERE is_active = true`,
  );

  let enqueued = 0;

  for (const { id: clientId } of clients.rows) {
    const due = await claimDueWorkflowCommands(client, { clientId, now });
    for (const command of due) {
      await enqueueInTransaction(boss, client, clientId, JOB_NAMES.RUN_WORKFLOW_COMMAND_V1, {
        schemaVersion: 1 as const,
        clientId,
        idempotencyKey: `workflow-command:${command.commandId}:${command.attempts}`,
        requestedAt: now.toISOString(),
        commandId: command.commandId,
        workflowInstanceId: command.workflowInstanceId,
        commandType: command.commandType,
        payload: command.payload,
      });
      enqueued += 1;
    }
  }

  return { enqueued };
}
