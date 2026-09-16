export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * 86e39qa78: the audit-ledger entity/event name shape -- a lowercase
 * dot/underscore/hyphen identifier -- was defined 3x: audit-log-routes.ts
 * and portal-content-routes.ts each re-declared it as their own
 * AUDIT_ENTITY_OR_EVENT constant, and write-audit-event.ts's
 * AuditEventInputSchema inlined the same regex literal twice (entity and
 * event fields).
 */
export const AUDIT_ENTITY_OR_EVENT_PATTERN = /^[a-z][a-z0-9_.-]*$/;
