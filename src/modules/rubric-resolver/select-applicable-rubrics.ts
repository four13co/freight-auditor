import type pg from 'pg';
import { z } from 'zod';

export const APPLICABILITY_SELECTOR_VERSION = 'rubric-applicability-v1';
const ModeSchema = z.enum(['OCEAN', 'AIR', 'MULTIMODAL', 'ROAD', 'RAIL']);
const RequestSchema = z.object({
  clientId: z.string().uuid(),
  contractId: z.string().uuid().optional(),
  mode: ModeSchema,
  effectiveOn: z.iso.date(),
  recordedAsOf: z.iso.datetime({ offset: true }),
}).strict();

export type RubricTier = 'STANDARD' | 'CLIENT' | 'CONTRACT';
export interface ApplicableRubricVersion {
  rubricId: string;
  rubricVersionId: string;
  tier: RubricTier;
  validFrom: string;
  validTo: string | null;
  recordedAt: string;
}

export class RubricApplicabilityInputError extends Error {
  readonly code = 'RUBRIC_APPLICABILITY_INVALID';
  constructor() {
    super('Invalid rubric applicability request');
    this.name = 'RubricApplicabilityInputError';
  }
}

/** Return the latest known effective version for every in-scope rubric. */
export async function selectApplicableRubricVersions(
  client: pg.PoolClient,
  untrustedRequest: unknown,
): Promise<readonly ApplicableRubricVersion[]> {
  const parsed = RequestSchema.safeParse(untrustedRequest);
  if (!parsed.success) throw new RubricApplicabilityInputError();
  const request = parsed.data;
  const rows = await client.query<{
    rubric_id: string; rubric_version_id: string; tier: RubricTier;
    valid_from: string; valid_to: string | null; recorded_at: Date | string;
  }>(
    `SELECT DISTINCT ON (r.id)
       r.id AS rubric_id, rv.id AS rubric_version_id, r.tier,
       rv.valid_from, rv.valid_to, rv.recorded_at
     FROM rubric r
     JOIN rubric_version rv ON rv.rubric_id = r.id
     WHERE (r.scope_client_id IS NULL OR r.scope_client_id = $1)
       AND (r.scope_contract_id IS NULL OR r.scope_contract_id = $2)
       AND (r.mode_filter IS NULL OR $3::transport_mode = ANY(r.mode_filter))
       AND rv.valid_from <= $4::date
       AND (rv.valid_to IS NULL OR rv.valid_to > $4::date)
       AND rv.recorded_at <= $5::timestamptz
     ORDER BY r.id, rv.valid_from DESC, rv.recorded_at DESC, rv.id DESC`,
    [request.clientId, request.contractId ?? null, request.mode, request.effectiveOn, request.recordedAsOf],
  );
  return rows.rows.map((row) => ({
    rubricId: row.rubric_id,
    rubricVersionId: row.rubric_version_id,
    tier: row.tier,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    recordedAt: row.recorded_at instanceof Date ? row.recorded_at.toISOString() : row.recorded_at,
  }));
}
