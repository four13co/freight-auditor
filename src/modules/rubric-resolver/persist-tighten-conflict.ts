import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import type { TightenProof } from './monotonic-tighten.js';

const postgresUuid = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
const InputSchema = z.object({
  tenantId: postgresUuid.nullable(),
  criterionKey: z.string().trim().min(1).max(255),
  baseRuleVersionId: postgresUuid,
  attemptedRuleVersionId: postgresUuid,
  proof: z.object({
    monotonic: z.literal(false),
    reason: z.enum(['UNSUPPORTED_SHAPE', 'OPERAND_CHANGED', 'BOUND_WEAKENED', 'CLAUSE_REMOVED']),
  }).strict(),
}).strict();

export type TightenConflictInput = z.infer<typeof InputSchema>;

export class TightenConflictValidationError extends Error {
  readonly code = 'TIGHTEN_CONFLICT_INVALID';
  constructor() {
    super('Invalid non-monotonic tightening conflict');
    this.name = 'TightenConflictValidationError';
  }
}

function deterministicConflictId(input: TightenConflictInput): string {
  const bytes = createHash('sha256').update(JSON.stringify([
    input.tenantId, input.criterionKey, input.baseRuleVersionId,
    input.attemptedRuleVersionId, input.proof.reason,
  ])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function persistTightenConflict(
  client: pg.PoolClient,
  untrustedInput: unknown,
): Promise<{ id: string; created: boolean }> {
  const parsed = InputSchema.safeParse(untrustedInput);
  if (!parsed.success) throw new TightenConflictValidationError();
  const input = parsed.data;
  const id = deterministicConflictId(input);
  const detail = {
    baseRuleVersionId: input.baseRuleVersionId,
    attemptedRuleVersionId: input.attemptedRuleVersionId,
    proofVersion: 'monotonic-tighten-v1',
    reason: input.proof.reason,
  };
  const result = await client.query<{ id: string; created: boolean }>(
    `WITH inserted AS (
       INSERT INTO resolution_conflict (id, tenant_id, criterion_key, conflict_type, detail)
       VALUES ($1, $2, $3, 'NON_MONOTONE_TIGHTEN', $4::jsonb)
       ON CONFLICT (id) DO NOTHING RETURNING id
     )
     SELECT id, true AS created FROM inserted
     UNION ALL
     SELECT id, false AS created FROM resolution_conflict
     WHERE id = $1 AND tenant_id IS NOT DISTINCT FROM $2::uuid
       AND criterion_key = $3 AND conflict_type = 'NON_MONOTONE_TIGHTEN'
       AND detail IS NOT DISTINCT FROM $4::jsonb`,
    [id, input.tenantId, input.criterionKey, JSON.stringify(detail)],
  );
  const row = result.rows[0];
  if (!row) throw new TightenConflictValidationError();
  return row;
}

export function isNonMonotonic(proof: TightenProof): proof is Extract<TightenProof, { monotonic: false }> {
  return !proof.monotonic;
}
