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

export type ReclaimStaleClaimsInput = z.input<typeof schema>;

export interface ReclaimedClaim {
  id: string;
  workflowInstanceId: string;
  attempts: number;
  outcome: 'reclaimed' | 'failed';
}

export interface ReclaimStaleClaimsResult {
  reclaimed: number;
  failed: number;
}

/**
 * 86e367r8f: shared shape behind reclaimStaleOutboxMessages and
 * reclaimStaleWorkflowCommands -- both recover rows stranded in 'claimed'
 * by a worker/process that crashed before its own completeX ever ran,
 * either back to 'pending' (fresh claim, attempts still under budget) or to
 * a terminal 'failed' once exhausted. `table` is never caller/user-supplied
 * -- each call site passes one of its own two hardcoded literal configs
 * below, so this interpolation carries no injection surface.
 */
export interface ReclaimStaleClaimsConfig {
  table: 'workflow_outbox_message' | 'workflow_command';
  entity: string;
  reclaimedEvent: string;
  failedEvent: string;
}

export async function reclaimStaleClaims(
  client: pg.PoolClient,
  config: Pick<ReclaimStaleClaimsConfig, 'table'>,
  untrusted: z.input<typeof schema>,
): Promise<ReclaimedClaim[]> {
  const input = schema.parse(untrusted);
  const cutoff = new Date(input.now.getTime() - input.staleAfterMinutes * 60_000);

  const result = await client.query<{
    id: string;
    workflow_instance_id: string;
    attempts: number;
    status: string;
  }>(
    `UPDATE ${config.table}
     SET status = CASE WHEN attempts >= $4 THEN 'failed' ELSE 'pending' END,
         claimed_at = NULL
     WHERE id IN (
       SELECT id FROM ${config.table}
       WHERE client_id = $1 AND status = 'claimed' AND claimed_at <= $2
       ORDER BY claimed_at
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, workflow_instance_id, attempts, status`,
    [input.clientId, cutoff.toISOString(), input.limit, input.maxAttempts],
  );

  return result.rows.map((row) => ({
    id: row.id,
    workflowInstanceId: row.workflow_instance_id,
    attempts: row.attempts,
    outcome: row.status === 'failed' ? 'failed' : 'reclaimed',
  }));
}

/**
 * Portfolio-wide tick: recovers stale claims for every active client and
 * records one audit event per row recovered.
 */
export async function reclaimStaleClaimsForActiveClients(
  client: pg.PoolClient,
  config: ReclaimStaleClaimsConfig,
  now: Date = new Date(),
): Promise<ReclaimStaleClaimsResult> {
  const clients = await client.query<{ id: string }>(
    `SELECT id FROM client WHERE is_active = true`,
  );

  let reclaimed = 0;
  let failed = 0;

  for (const { id: clientId } of clients.rows) {
    const rows = await reclaimStaleClaims(client, config, { clientId, now });
    for (const row of rows) {
      if (row.outcome === 'failed') failed += 1;
      else reclaimed += 1;

      const event = row.outcome === 'failed' ? config.failedEvent : config.reclaimedEvent;
      await writeAuditEvent(client, {
        id: deterministicAuditEventId(clientId, row.id, event, String(row.attempts)),
        clientId,
        entity: config.entity,
        entityId: row.id,
        event,
        actorKind: 'system',
        detail: { workflowInstanceId: row.workflowInstanceId, attempts: row.attempts },
      });
    }
  }

  return { reclaimed, failed };
}
