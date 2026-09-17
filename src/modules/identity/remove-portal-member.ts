import type pg from 'pg';
import { PORTAL_ROLES } from './update-portal-member-role.js';

export interface RemovePortalMemberResult {
  /** false when the membership doesn't exist, isn't visible under RLS for this tenant, or its role isn't client_viewer/client_admin -- caller maps this to 404. */
  found: boolean;
}

/**
 * 86e3a6rgu (PR #408 review fix): removes a membership row, restricted to
 * this client's own portal-manageable surface -- same "current role must
 * already be a portal role" structural guarantee update-portal-member-
 * role.ts's UPDATE already enforces for edits. The generic remove-
 * membership.ts (used by the internal /api/internal/tenants/:id/members
 * route) has no such role filter by design -- an internal analyst is
 * allowed to remove ANY membership row, including another analyst's -- so
 * reusing it here would let a client_admin delete the internal analyst
 * membership row servicing their own client. Caught by
 * portal-admin-routes.db.test.ts's own "cannot remove the internal analyst
 * membership row" case.
 */
export async function removePortalMember(
  client: pg.PoolClient,
  clientId: string,
  membershipId: string,
): Promise<RemovePortalMemberResult> {
  const { rowCount } = await client.query(
    `DELETE FROM membership WHERE id = $1 AND client_id = $2 AND role = ANY($3::membership_role[])`,
    [membershipId, clientId, PORTAL_ROLES],
  );
  return { found: (rowCount ?? 0) > 0 };
}
