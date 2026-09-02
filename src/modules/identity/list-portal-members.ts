import type pg from 'pg';

/**
 * One row of the client portal's own membership roster (P6.A.4). Runs
 * inside the caller's withTenantTx -- RLS is FORCE-enabled on membership
 * (migration 0009), so a query issued outside that transaction silently
 * returns zero rows, never an error, matching list-claims.ts's own
 * convention. `clientId` is an explicit predicate on top of RLS, not a
 * replacement for it (86e31a9ch/#216 precedent).
 */
export interface PortalMemberRow {
  id: string;
  userId: string;
  email: string;
  role: 'client_viewer' | 'client_admin';
  createdAt: Date;
}

export interface ListPortalMembersOptions {
  limit?: number;
  offset?: number;
  /** Keyset position (P6.C.1 precedent): resume after this row. See list-claims.ts's ListClaimsOptions.cursor for why only `id` is threaded through, never a client-round-tripped timestamp. */
  cursor?: { id: string };
}

const DEFAULT_LIMIT = 50;

// Only the two portal-facing roles are ever surfaced through this endpoint --
// an internal analyst/lead who happens to hold a membership row for this
// client (e.g. servicing it) must never appear in, or be reachable through,
// a client-facing member roster. This is P6.A.4's own tenant/role boundary,
// enforced in the query itself, not left to a route-level filter a future
// caller could bypass.
const PORTAL_ROLES = ['client_viewer', 'client_admin'] as const;

/**
 * List this client's own portal-role membership rows (client_viewer/
 * client_admin only), joined to the member's email. Sorted newest-first
 * (created_at DESC, id ASC as a total-order tiebreaker -- same convention
 * P6.C.1 established for list-claims.ts/list-gate-failures.ts).
 */
export async function listPortalMembers(
  client: pg.PoolClient,
  clientId: string,
  options: ListPortalMembersOptions = {},
): Promise<PortalMemberRow[]> {
  const conditions: string[] = ['membership.client_id = $1', 'membership.role = ANY($2::membership_role[])'];
  const params: unknown[] = [clientId, PORTAL_ROLES];

  let fromClause = 'FROM membership JOIN app_user ON app_user.id = membership.user_id';
  if (options.cursor) {
    params.push(options.cursor.id);
    const cursorIdIdx = params.length;
    // cursor_anchor re-reads the anchor row's OWN created_at from the DB,
    // never a client-round-tripped timestamp -- node-pg's timestamptz parser
    // truncates to millisecond precision while the column holds
    // microseconds, which silently drops a tied row otherwise (P6.C.1,
    // discovered and fixed the same way in list-claims.ts).
    fromClause += `, (
      SELECT created_at AS anchor_created_at, id AS anchor_id
        FROM membership AS cursor_row
       WHERE cursor_row.id = $${cursorIdIdx} AND cursor_row.client_id = $1
    ) cursor_anchor`;
    conditions.push('(membership.created_at < cursor_anchor.anchor_created_at OR (membership.created_at = cursor_anchor.anchor_created_at AND membership.id > cursor_anchor.anchor_id))');
  }

  const limit = options.limit ?? DEFAULT_LIMIT;
  let limitOffsetClause: string;
  if (options.cursor) {
    params.push(limit);
    limitOffsetClause = `LIMIT $${params.length}`;
  } else {
    const offset = options.offset ?? 0;
    params.push(limit, offset);
    limitOffsetClause = `LIMIT $${params.length - 1} OFFSET $${params.length}`;
  }

  const { rows } = await client.query<{
    id: string; user_id: string; email: string; role: 'client_viewer' | 'client_admin'; created_at: Date;
  }>(
    `SELECT membership.id, membership.user_id, app_user.email, membership.role, membership.created_at
       ${fromClause}
      WHERE ${conditions.join(' AND ')}
      ORDER BY membership.created_at DESC, membership.id ASC
      ${limitOffsetClause}`,
    params,
  );

  return rows.map((r) => ({ id: r.id, userId: r.user_id, email: r.email, role: r.role, createdAt: r.created_at }));
}
