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
 *
 * Runs the UPDATE + finding_assignment_event INSERT in one statement (a CTE
 * chain), same convention as updateFindingStatus, so the audit event id can
 * hash on the freshly-inserted event row's own id (migration 0081) instead
 * of a coarse (client_id, finding_id, event) tuple -- 'event' only has two
 * values, so that coarser hash collided across an assign/unassign/assign
 * toggle and writeAuditEvent's ON CONFLICT (id) DO NOTHING silently dropped
 * the repeat write.
 */
export async function assignFinding(
  client: pg.PoolClient,
  findingId: string,
  assigneeUserId: string | null,
  actorUserId?: string,
): Promise<AssignFindingResult> {
  const result = await client.query<{ id: string; client_id: string; assignment_event_id: string }>(
    `WITH updated AS (
       UPDATE variance_finding
       SET assigned_to_user_id = $2
       WHERE id = $1
       RETURNING id, client_id
     ),
     logged AS (
       INSERT INTO finding_assignment_event (client_id, variance_finding_id, assigned_to_user_id, actor_user_id)
       SELECT updated.client_id, updated.id, $2, $3
       FROM updated
       RETURNING id, variance_finding_id
     )
     SELECT updated.id, updated.client_id, (SELECT id FROM logged) AS assignment_event_id
     FROM updated`,
    [findingId, assigneeUserId, actorUserId ?? null],
  );

  const row = result.rows[0];
  if (!row) return { found: false };

  await writeAuditEvent(client, {
    id: deterministicAuditEventId(row.client_id, row.assignment_event_id, assigneeUserId ? 'finding.assigned' : 'finding.unassigned'),
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
