import type pg from 'pg';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';

export interface ApproveDisputeResult {
  /** false when the dispute doesn't exist, isn't visible under RLS, or is not currently 'draft' -- caller maps this to 404/409 as appropriate. */
  found: boolean;
}

/**
 * Approves a draft dispute for delivery (P4.C.6): draft -> sent. Unlike
 * update-finding-status.ts's CTE-chain pattern (which keeps a mutable
 * current-state row in sync with its OWN append-only history table),
 * dispute has no dispute_status_event history table -- so this is a plain
 * guarded UPDATE + writeAuditEvent, mirroring generate-hold-decision.ts's
 * style rather than the transition-log pattern.
 *
 * `WHERE status = 'draft'` guards the from-state: approving an
 * already-sent (or otherwise non-draft) dispute is a no-op returning
 * `found: false` rather than silently re-sending it -- this IS the
 * idempotency guarantee, since there is no separate history row to make
 * a duplicate transition detectable after the fact.
 */
export async function approveDispute(
  client: pg.PoolClient,
  disputeId: string,
  actorUserId: string,
): Promise<ApproveDisputeResult> {
  const result = await client.query<{ id: string; client_id: string }>(
    `UPDATE dispute SET status = 'sent' WHERE id = $1 AND status = 'draft' RETURNING id, client_id`,
    [disputeId],
  );

  const row = result.rows[0];
  if (!row) return { found: false };

  await writeAuditEvent(client, {
    id: deterministicAuditEventId(row.client_id, row.id, 'dispute.approved'),
    clientId: row.client_id,
    entity: 'dispute',
    entityId: row.id,
    event: 'dispute.approved',
    actorKind: 'analyst',
    actorUserId,
    detail: { fromStatus: 'draft', toStatus: 'sent' },
  });

  return { found: true };
}
