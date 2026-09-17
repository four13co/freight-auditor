import type pg from 'pg';
import { buildKeysetAnchorFrom, buildKeysetTieBreak, buildLimitOffsetClause } from '../../shared/cursor-pagination.js';

export interface AllTenantMemberRow {
  id: string;
  userId: string;
  email: string;
  fullName: string | null;
  role: string;
  isActive: boolean;
  clientId: string;
  clientName: string;
  createdAt: Date;
}

export interface ListAllTenantMembersOptions {
  limit?: number;
  offset?: number;
  /** Keyset position (cursor-pagination.ts's KeysetCursor.id, same convention as list-clients.ts). */
  cursor?: { id: string };
}

const DEFAULT_LIMIT = 50;

/**
 * 86e3a75mf: the cross-tenant paginated members view -- replaces
 * fetchAllUsers()'s client-side GET /api/internal/tenants (capped at
 * limit=100) -> GET /api/internal/tenants/:id/members per-tenant fan-out,
 * which silently dropped tenants past 100 and paginated members entirely
 * client-side. GET /api/internal/tenants already paginates the tenant list
 * itself server-side (tenant-admin-routes.ts:71-102 / list-clients.ts) --
 * this is the equivalent for the members-aggregation gap specifically.
 *
 * Runs inside the caller's internal-scoped withTenantTx -- membership
 * carries FORCE RLS keyed on client_id (migration 0009), so
 * app_is_internal() is what admits every tenant's rows here, same as
 * list-tenant-members.ts. membership.id is globally unique (not just unique
 * per tenant), so a keyset cursor anchored on (created_at, id) resolves to a
 * total order across every tenant exactly as it does within one -- same
 * shared helpers list-clients.ts uses.
 */
export async function listAllTenantMembers(
  client: pg.PoolClient,
  options: ListAllTenantMembersOptions = {},
): Promise<AllTenantMemberRow[]> {
  const params: unknown[] = [];
  let fromClause = 'FROM membership JOIN app_user ON app_user.id = membership.user_id JOIN client ON client.id = membership.client_id';
  const conditions: string[] = [];

  if (options.cursor) {
    const anchor = buildKeysetAnchorFrom(params, { table: 'membership', tsColumn: 'created_at', cursorId: options.cursor.id });
    fromClause += anchor.fromClauseAddition;
    conditions.push(buildKeysetTieBreak('membership.created_at', 'membership.id', anchor.anchorTsAlias));
  }

  const limit = options.limit ?? DEFAULT_LIMIT;
  const limitOffsetClause = buildLimitOffsetClause(params, { limit, offset: options.offset, hasCursor: Boolean(options.cursor) });

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await client.query<{
    id: string; user_id: string; email: string; full_name: string | null; role: string;
    is_active: boolean; client_id: string; client_name: string; created_at: Date;
  }>(
    `SELECT membership.id, membership.user_id, app_user.email, app_user.full_name, membership.role,
            membership.is_active, membership.client_id, client.name AS client_name, membership.created_at
       ${fromClause}
      ${where}
      ORDER BY membership.created_at DESC, membership.id ASC
      ${limitOffsetClause}`,
    params,
  );

  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    email: r.email,
    fullName: r.full_name,
    role: r.role,
    isActive: r.is_active,
    clientId: r.client_id,
    clientName: r.client_name,
    createdAt: r.created_at,
  }));
}
