import type pg from 'pg';

export interface ClientAuditEventRow {
  id: string;
  entity: string;
  entityId: string | null;
  event: string;
  actorKind: string;
  recordedAt: Date;
}

export interface ListClientAuditEventsOptions {
  entity?: string;
  event?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 50;

/**
 * Client portal audit-log browser read (P6.B.6). Deliberately omits
 * `detail` (jsonb): it's populated by writeAuditEvent call sites across
 * every internal workflow path with no schema constraining its contents --
 * an unbounded internal payload with no place on a client-facing read. No
 * AC branch needs it; entity/event/actorKind/recordedAt is the reviewable
 * surface for "browse the audit trail."
 *
 * `client_id = $1` is NOT merely defense-in-depth here, unlike this
 * surface's sibling modules -- audit_event.client_id is NULLABLE ("NULL for
 * system-global events", migration 0008), and the tenant_isolation RLS
 * policy's own USING clause admits a NULL-client row unconditionally
 * (`client_id IS NULL OR app_is_internal() OR ...`, migration 0009). Under
 * RLS alone, every system-global audit event across every tenant's
 * operations would leak into a client_viewer's result set. This predicate
 * is what actually enforces client-scoping on this table, not a backstop
 * against a misconfigured internal scope.
 */
export async function listClientAuditEvents(
  client: pg.PoolClient,
  clientId: string,
  options: ListClientAuditEventsOptions = {},
): Promise<ClientAuditEventRow[]> {
  const conditions: string[] = ['client_id = $1'];
  const params: unknown[] = [clientId];

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

  const where = `WHERE ${conditions.join(' AND ')}`;
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
