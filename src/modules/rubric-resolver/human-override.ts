import type pg from 'pg';
import { z } from 'zod';

export const HUMAN_OVERRIDE_RESOLVER_VERSION = 'human-override-resolver-v1';
const RequestSchema = z.object({
  clientId: z.string().uuid(),
  criterionId: z.string().uuid(),
  caseFingerprint: z.string().trim().min(1).max(1000),
  recordedAsOf: z.iso.datetime({ offset: true }),
}).strict();

export type HumanOverrideResolution =
  | { status: 'FOUND'; overrideId: string; assertedValue: unknown; recordedAt: string; resolverVersion: string }
  | { status: 'NOT_FOUND'; resolverVersion: string };

export class HumanOverrideRequestError extends Error {
  readonly code = 'HUMAN_OVERRIDE_REQUEST_INVALID';
  constructor() {
    super('Invalid human override request');
    this.name = 'HumanOverrideRequestError';
  }
}

export async function resolveHumanOverride(
  client: pg.PoolClient,
  untrustedRequest: unknown,
): Promise<HumanOverrideResolution> {
  const parsed = RequestSchema.safeParse(untrustedRequest);
  if (!parsed.success) throw new HumanOverrideRequestError();
  const request = parsed.data;
  const row = (await client.query<{ id: string; asserted_value: unknown; recorded_at: Date | string }>(
    `SELECT id, asserted_value, recorded_at FROM human_override
     WHERE (client_id = $1 OR client_id IS NULL)
       AND criterion_id = $2 AND case_fingerprint = $3
       AND recorded_at <= $4::timestamptz
     ORDER BY (client_id = $1) DESC, recorded_at DESC, id DESC
     LIMIT 1`,
    [request.clientId, request.criterionId, request.caseFingerprint, request.recordedAsOf],
  )).rows[0];
  if (!row) return { status: 'NOT_FOUND', resolverVersion: HUMAN_OVERRIDE_RESOLVER_VERSION };
  return {
    status: 'FOUND', overrideId: row.id, assertedValue: row.asserted_value,
    recordedAt: row.recorded_at instanceof Date ? row.recorded_at.toISOString() : row.recorded_at,
    resolverVersion: HUMAN_OVERRIDE_RESOLVER_VERSION,
  };
}

export function applyHumanOverride<T>(
  cascadedValue: T,
  resolution: HumanOverrideResolution,
): { value: T | unknown; humanOverrideId: string | null } {
  return resolution.status === 'FOUND'
    ? { value: resolution.assertedValue, humanOverrideId: resolution.overrideId }
    : { value: cascadedValue, humanOverrideId: null };
}
