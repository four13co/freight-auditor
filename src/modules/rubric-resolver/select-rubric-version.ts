import type pg from 'pg';
import { z } from 'zod';

export const RUBRIC_VERSION_SELECTOR_VERSION = 'rubric-version-selector-v1';

const RequestSchema = z.object({
  rubricId: z.string().uuid(),
  effectiveOn: z.iso.date(),
  recordedAsOf: z.iso.datetime({ offset: true }),
}).strict();

export interface SelectedRubricVersion {
  id: string;
  rubricId: string;
  validFrom: string;
  validTo: string | null;
  recordedAt: string;
  selectorVersion: typeof RUBRIC_VERSION_SELECTOR_VERSION;
}

export type RubricVersionSelection =
  | { status: 'FOUND'; version: SelectedRubricVersion }
  | { status: 'UNAVAILABLE'; reason: 'NO_VERSION_KNOWN' };

export class RubricVersionSelectionInputError extends Error {
  readonly code = 'RUBRIC_VERSION_SELECTION_INVALID';
  constructor(readonly issues: ReadonlyArray<{ path: string; code: string }>) {
    super('Invalid rubric version selection request');
    this.name = 'RubricVersionSelectionInputError';
  }
}

/** Select what version was effective on a business date and known at a system-time cutoff. */
export async function selectRubricVersion(
  client: pg.PoolClient,
  untrustedRequest: unknown,
): Promise<RubricVersionSelection> {
  const parsed = RequestSchema.safeParse(untrustedRequest);
  if (!parsed.success) {
    throw new RubricVersionSelectionInputError(parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'), code: issue.code,
    })));
  }
  const request = parsed.data;
  const selected = await client.query<{
    id: string; rubric_id: string; valid_from: string; valid_to: string | null; recorded_at: Date | string;
  }>(
    `SELECT id, rubric_id, valid_from, valid_to, recorded_at
     FROM rubric_version
     WHERE rubric_id = $1
       AND valid_from <= $2::date
       AND (valid_to IS NULL OR valid_to > $2::date)
       AND recorded_at <= $3::timestamptz
     ORDER BY valid_from DESC, recorded_at DESC, id DESC
     LIMIT 1`,
    [request.rubricId, request.effectiveOn, request.recordedAsOf],
  );
  const row = selected.rows[0];
  if (!row) return { status: 'UNAVAILABLE', reason: 'NO_VERSION_KNOWN' };
  return {
    status: 'FOUND',
    version: {
      id: row.id,
      rubricId: row.rubric_id,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      recordedAt: row.recorded_at instanceof Date ? row.recorded_at.toISOString() : row.recorded_at,
      selectorVersion: RUBRIC_VERSION_SELECTOR_VERSION,
    },
  };
}
