import type pg from 'pg';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const jsonValue: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(),
  z.array(jsonValue), z.record(z.string(), jsonValue),
]));

export const AuditEventInputSchema = z.object({
  id: z.string().uuid(),
  clientId: z.string().uuid().nullable(),
  entity: z.string().trim().min(1).max(100).regex(/^[a-z][a-z0-9_.-]*$/),
  entityId: z.string().uuid().nullable().default(null),
  event: z.string().trim().min(1).max(100).regex(/^[a-z][a-z0-9_.-]*$/),
  actorKind: z.enum(['analyst', 'ai', 'system']),
  actorUserId: z.string().uuid().nullable().default(null),
  ruleVersionId: z.string().uuid().nullable().default(null),
  rubricSnapshotId: z.string().uuid().nullable().default(null),
  detail: jsonValue.nullable().default(null),
}).strict().superRefine((value, context) => {
  if (value.actorKind === 'analyst' && value.actorUserId === null) {
    context.addIssue({ code: 'custom', path: ['actorUserId'], message: 'analyst actor requires actorUserId' });
  }
});

export type AuditEventInput = z.input<typeof AuditEventInputSchema>;

export class AuditEventValidationError extends Error {
  readonly code = 'AUDIT_EVENT_INVALID';
  constructor(readonly issues: ReadonlyArray<{ path: string; code: string }>) {
    super('Invalid audit event');
    this.name = 'AuditEventValidationError';
  }
}

export class AuditEventConflictError extends Error {
  readonly code = 'AUDIT_EVENT_CONFLICT';
  constructor() {
    super('Audit event id is already bound to different immutable evidence');
    this.name = 'AuditEventConflictError';
  }
}

export function deterministicAuditEventId(...parts: string[]): string {
  const bytes = createHash('sha256').update(parts.join('\0')).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function writeAuditEvent(
  client: pg.PoolClient,
  untrustedInput: AuditEventInput,
): Promise<{ id: string; created: boolean }> {
  const parsed = AuditEventInputSchema.safeParse(untrustedInput);
  if (!parsed.success) {
    throw new AuditEventValidationError(parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'), code: issue.code,
    })));
  }
  const value = parsed.data;
  const params = [
    value.id, value.clientId, value.entity, value.entityId, value.event,
    value.actorKind, value.actorUserId, value.ruleVersionId,
    value.rubricSnapshotId, value.detail,
  ];
  const result = await client.query<{ id: string; created: boolean }>(
    `WITH inserted AS (
       INSERT INTO audit_event
         (id, client_id, entity, entity_id, event, actor_kind, actor_user_id,
          rule_version_id, rubric_snapshot_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6::actor_kind, $7, $8, $9, $10::jsonb)
       ON CONFLICT (id) DO NOTHING
       RETURNING id
     )
     SELECT id, true AS created FROM inserted
     UNION ALL
     SELECT id, false AS created FROM audit_event
     WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM inserted)
       AND client_id IS NOT DISTINCT FROM $2::uuid
       AND entity = $3 AND entity_id IS NOT DISTINCT FROM $4::uuid
       AND event = $5 AND actor_kind = $6::actor_kind
       AND actor_user_id IS NOT DISTINCT FROM $7::uuid
       AND rule_version_id IS NOT DISTINCT FROM $8::uuid
       AND rubric_snapshot_id IS NOT DISTINCT FROM $9::uuid
       AND detail IS NOT DISTINCT FROM $10::jsonb`,
    params,
  );
  const row = result.rows[0];
  if (!row) throw new AuditEventConflictError();
  return row;
}
