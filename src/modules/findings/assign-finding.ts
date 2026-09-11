import type pg from 'pg';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';

export interface AssignFindingResult {
  /** false when the finding doesn't exist / isn't visible under RLS for this tenant -- caller maps this to 404. */
  found: boolean;
}

/**
 * Self-assign or unassign a variance_finding (86e37r2t8). `assigneeUserId`
 * is either the acting analyst's own id (assign) or `null` (unassign) --
 * this function trusts whatever id it's given, same as updateFindingStatus
 * trusts its `toStatus` -- the route layer (findings-routes.ts) is what
 * enforces "assigneeUserId is always the caller's own actorUserId, never a
 * client-supplied one," per this item's own Rabbit holes.
 *
 * RLS (FORCE-enabled on variance_finding) means the UPDATE affects zero rows
 * for a finding outside the caller's tenant scope, same "silently zero,
 * never an error" convention updateFindingStatus/listFindings already rely
 * on -- `found: false` covers both "doesn't exist" and "not yours."
 */
export async function assignFinding(
  client: pg.PoolClient,
  findingId: string,
  assigneeUserId: string | null,
  actorUserId?: string,
): Promise<AssignFindingResult> {
  const result = await client.query<{ id: string; client_id: string }>(
    `UPDATE variance_finding
     SET assigned_to_user_id = $2
     WHERE id = $1
     RETURNING id, client_id`,
    [findingId, assigneeUserId],
  );

  const row = result.rows[0];
  if (!row) return { found: false };

  await writeAuditEvent(client, {
    id: deterministicAuditEventId(row.client_id, row.id, assigneeUserId ? 'finding.assigned' : 'finding.unassigned'),
    clientId: row.client_id,
    entity: 'variance_finding',
    entityId: row.id,
    event: assigneeUserId ? 'finding.assigned' : 'finding.unassigned',
    actorKind: 'analyst',
    actorUserId: actorUserId ?? null,
    detail: { assignedToUserId: assigneeUserId },
  });
  return { found: true };
}
