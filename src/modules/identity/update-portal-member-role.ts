import type pg from 'pg';
import { deterministicAuditEventId, writeAuditEvent } from '../audit-ledger/write-audit-event.js';

export type PortalRole = 'client_viewer' | 'client_admin';

export const PORTAL_ROLES: readonly PortalRole[] = ['client_viewer', 'client_admin'];

export interface UpdatePortalMemberRoleResult {
  /** false when the membership doesn't exist, isn't visible under RLS for this tenant, or its CURRENT role isn't client_viewer/client_admin -- caller maps this to 404. */
  found: boolean;
}

/**
 * Transition a membership row's role, restricted to this client's own
 * portal-manageable surface (P6.A.4). The UPDATE's own WHERE clause requires
 * the row's CURRENT role to already be client_viewer or client_admin --
 * an internal analyst/lead's membership row can never be touched through
 * this path, structurally, not by a route-level check a future caller could
 * bypass (same class of guarantee as client-viewer-auth.ts's method-based
 * read-only enforcement). `newRole` is validated by the caller's type
 * (PortalRole) and, at the route boundary, against PORTAL_ROLES -- this
 * function never accepts an arbitrary membership_role.
 *
 * RLS (FORCE-enabled on membership) means the UPDATE affects zero rows for a
 * membership outside the caller's tenant scope -- the same "silently zero,
 * never an error" convention update-finding-status.ts relies on -- so
 * `found: false` covers "doesn't exist," "not yours," and "not a portal
 * role" alike, and no audit_event is written in any of those cases either.
 *
 * Idempotency note: unlike update-finding-status.ts (which inserts a fresh
 * finding_status_event row and derives the audit event's id from that row's
 * own freshly-generated id), this table has no append-only history sibling,
 * so the audit event id is deterministic on (clientId, membershipId,
 * targetRole) alone -- same shape as resolve-claim.ts's own
 * deterministicAuditEventId call. A genuine repeat of the exact same
 * transition (e.g. promote to client_admin, demote, promote to client_admin
 * again) collides on that id and the second audit_event insert is a silent
 * no-op (ON CONFLICT DO NOTHING) -- the membership UPDATE itself still runs
 * and returns found: true correctly; only the duplicate audit trail entry
 * is missing. Accepted as the same trade-off resolve-claim.ts already ships
 * with, not introduced here; a full fix would need an append-only
 * membership_role_change table, out of this task's appetite.
 */
export async function updatePortalMemberRole(
  client: pg.PoolClient,
  clientId: string,
  membershipId: string,
  newRole: PortalRole,
  actorUserId: string | undefined,
): Promise<UpdatePortalMemberRoleResult> {
  const result = await client.query<{ id: string; client_id: string; from_role: PortalRole }>(
    `WITH old AS (
       SELECT id, client_id, role AS from_role
         FROM membership
        WHERE id = $1 AND client_id = $2 AND role = ANY($4::membership_role[])
     ),
     updated AS (
       UPDATE membership
          SET role = $3::membership_role
        WHERE id = (SELECT id FROM old)
        RETURNING id, client_id
     )
     SELECT updated.id, updated.client_id, (SELECT from_role FROM old) AS from_role
       FROM updated`,
    [membershipId, clientId, newRole, PORTAL_ROLES],
  );

  const row = result.rows[0];
  if (!row) return { found: false };

  const event = `membership.role_changed_to_${newRole}`;
  await writeAuditEvent(client, {
    id: deterministicAuditEventId(row.client_id, row.id, event),
    clientId: row.client_id,
    entity: 'membership',
    entityId: row.id,
    event,
    actorKind: 'client',
    actorUserId: actorUserId ?? null,
    detail: { fromRole: row.from_role, toRole: newRole },
  });

  return { found: true };
}
