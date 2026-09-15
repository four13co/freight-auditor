import type pg from 'pg';

export interface ClientRow {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  createdAt: Date;
}

export interface ListClientsOptions {
  limit?: number;
  offset?: number;
  /** Keyset position (cursor-pagination.ts's KeysetCursor.id, same convention as list-portal-members.ts). */
  cursor?: { id: string };
}

const DEFAULT_LIMIT = 50;

/**
 * 86e38rdnm: the tenant-admin list. `client` carries no RLS (migration
 * 0009's pairs list excludes it -- it is the tenant root, not tenant-scoped
 * data), so this is a plain query with no tenant context required beyond
 * the route's own internal-analyst gate.
 */
export async function listClients(client: pg.PoolClient, options: ListClientsOptions = {}): Promise<ClientRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let fromClause = 'FROM client';

  if (options.cursor) {
    params.push(options.cursor.id);
    const cursorIdIdx = params.length;
    fromClause += `, (
      SELECT created_at AS anchor_created_at, id AS anchor_id
        FROM client AS cursor_row
       WHERE cursor_row.id = $${cursorIdIdx}
    ) cursor_anchor`;
    conditions.push('(client.created_at < cursor_anchor.anchor_created_at OR (client.created_at = cursor_anchor.anchor_created_at AND client.id > cursor_anchor.anchor_id))');
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

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await client.query<{
    id: string; name: string; slug: string; is_active: boolean; created_at: Date;
  }>(
    `SELECT client.id, client.name, client.slug, client.is_active, client.created_at
       ${fromClause}
      ${where}
      ORDER BY client.created_at DESC, client.id ASC
      ${limitOffsetClause}`,
    params,
  );

  return rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, isActive: r.is_active, createdAt: r.created_at }));
}
