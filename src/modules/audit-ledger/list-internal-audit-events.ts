import type pg from 'pg';

export interface InternalAuditEventRow {
  id: string;
  entity: string;
  entityId: string | null;
  event: string;
  actorKind: string;
  recordedAt: Date;
}

export interface ListInternalAuditEventsOptions {
  entity?: string;
  event?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 50;

/**
 * Internal-analyst audit-log browser read (86e37r2rv), the cross-client
 * counterpart to list-client-audit-events.ts's listClientAuditEvents. Same
 * shape of rows and same column set (deliberately omits `detail`, for the
 * same reason: an unbounded internal payload with no place on this
 * reviewable surface), but no `client_id` predicate at all -- unlike the
 * portal read, this is meant to see every tenant's events, the same
 * cross-client shape getCrossClientPortfolio.ts uses. Safety is entirely
 * the tenant_isolation RLS policy reading the transaction's
 * app.is_internal GUC (set by withTenantReadTx/withTenantTx under an
 * `{ internal: true }` context) -- see that module's own header comment
 * for the precedent (P5.C.3 / PR #247) this follows.
 */
export async function listInternalAuditEvents(
  client: pg.PoolClient,
  options: ListInternalAuditEventsOptions = {},
): Promise<InternalAuditEventRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.entity) {
    params.push(options.entity);
    conditions.push(`entity = $${params.length}`);
  }
  if (options.event) {
    params.push(options.event);
    conditions.push(`event = $${params.length}`);
  }
  if (options.from) {
    params.push(options.from);
    conditions.push(`recorded_at >= $${params.length}`);
  }
  if (options.to) {
    params.push(options.to);
    conditions.push(`recorded_at <= $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options.limit ?? DEFAULT_LIMIT;
  const offset = options.offset ?? 0;
  params.push(limit, offset);

  const result = await client.query<{
    id: string; entity: string; entity_id: string | null; event: string; actor_kind: string; recorded_at: Date;
  }>(
    `SELECT id, entity, entity_id, event, actor_kind, recorded_at
       FROM audit_event
       ${where}
       ORDER BY recorded_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return result.rows.map((row) => ({
    id: row.id,
    entity: row.entity,
    entityId: row.entity_id,
    event: row.event,
    actorKind: row.actor_kind,
    recordedAt: row.recorded_at,
  }));
}
