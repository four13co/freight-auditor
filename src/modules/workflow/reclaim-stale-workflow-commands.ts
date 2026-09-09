import type pg from 'pg';
import { reclaimStaleClaims, reclaimStaleClaimsForActiveClients, type ReclaimStaleClaimsInput } from './reclaim-stale-claims.js';

export interface ReclaimedWorkflowCommand {
  commandId: string;
  workflowInstanceId: string;
  attempts: number;
  outcome: 'reclaimed' | 'failed';
}

const CONFIG = {
  table: 'workflow_command',
  entity: 'workflow_command',
  reclaimedEvent: 'workflow.command_reclaimed',
  failedEvent: 'workflow.command_failed',
} as const;

/**
 * Recovers workflow_command rows stranded in 'claimed' by a worker/process
 * that crashed (or a job that permanently failed) before completeWorkflow-
 * Command ever ran -- P4.A.4's own docstring (schedule-workflow-command-
 * jobs.ts) names this exact gap and defers it here. Shared SQL/CAS logic
 * lives in reclaim-stale-claims.ts (86e367r8f).
 *
 * staleAfterMinutes defaults comfortably above this queue's own pg-boss
 * retry budget (policies.ts: expireInMinutes 15, retryLimit 5 @ retryDelay
 * 30s backoff) so pg-boss's own retry gets first chance to resume a merely-
 * slow job before this reclaims the row out from under a still-in-flight
 * retry.
 */
export async function reclaimStaleWorkflowCommands(
  client: pg.PoolClient,
  untrusted: ReclaimStaleClaimsInput,
): Promise<ReclaimedWorkflowCommand[]> {
  const rows = await reclaimStaleClaims(client, CONFIG, untrusted);
  return rows.map((row) => ({
    commandId: row.id,
    workflowInstanceId: row.workflowInstanceId,
    attempts: row.attempts,
    outcome: row.outcome,
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
  return reclaimStaleClaimsForActiveClients(client, CONFIG, now);
}
