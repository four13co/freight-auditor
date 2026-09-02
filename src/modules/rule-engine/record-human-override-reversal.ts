import type pg from 'pg';
import { isUuid } from '../../shared/request-validation.js';
import { quarantineOnReversal } from './quarantine-on-reversal.js';

/**
 * P6.C.8: the first write path to `human_override`. The table is
 * append-only (migration 0010 grants `freight_app` only SELECT+INSERT, no
 * UPDATE) -- recording a reversal means INSERTing a new row with
 * reversal_count = 1, never mutating an existing row's count. This matches
 * the deleted quarantine-on-reversal.ts's own SUM(reversal_count) query,
 * which only makes sense if each row is a per-event flag (0 or 1), not a
 * cumulative snapshot.
 */
export class InvalidReversalRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'InvalidReversalRequestError';
  }
}

export interface RecordReversalInput {
  clientId: string;
  criterionId: string;
  ruleVersionId: string;
  caseFingerprint: string;
  assertedValue: unknown;
}

export interface RecordReversalResult {
  humanOverrideId: string;
  quarantined: boolean;
  ruleVersionId: string;
}

/**
 * Validates clientId/criterionId are well-formed UUIDs AND exist (86e2xcn18
 * bug class: a malformed/nonexistent id reaching a raw INSERT surfaces as
 * an uncaught 500 with raw Postgres detail instead of a clean error) before
 * inserting the reversal row, then runs the reintroduced quarantine check
 * in the same transaction.
 */
export async function recordHumanOverrideReversal(
  client: pg.PoolClient,
  input: RecordReversalInput,
): Promise<RecordReversalResult> {
  if (!isUuid(input.clientId)) throw new InvalidReversalRequestError('INVALID_CLIENT_ID', 'clientId must be a well-formed UUID');
  if (!isUuid(input.criterionId)) throw new InvalidReversalRequestError('INVALID_CRITERION_ID', 'criterionId must be a well-formed UUID');
  if (!isUuid(input.ruleVersionId)) throw new InvalidReversalRequestError('INVALID_RULE_VERSION_ID', 'ruleVersionId must be a well-formed UUID');
  if (!input.caseFingerprint.trim()) throw new InvalidReversalRequestError('INVALID_CASE_FINGERPRINT', 'caseFingerprint is required');

  const clientRow = await client.query(`SELECT id FROM client WHERE id = $1`, [input.clientId]);
  if (!clientRow.rowCount) throw new InvalidReversalRequestError('CLIENT_NOT_FOUND', `client not found: ${input.clientId}`);

  const criterionRow = await client.query(`SELECT id FROM criterion WHERE id = $1`, [input.criterionId]);
  if (!criterionRow.rowCount) throw new InvalidReversalRequestError('CRITERION_NOT_FOUND', `criterion not found: ${input.criterionId}`);

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO human_override (client_id, criterion_id, case_fingerprint, asserted_value, confirm_count, reversal_count)
     VALUES ($1, $2, $3, $4::jsonb, 0, 1)
     RETURNING id`,
    [input.clientId, input.criterionId, input.caseFingerprint, JSON.stringify(input.assertedValue)],
  );
  const humanOverrideId = inserted.rows[0]!.id;

  const quarantine = await quarantineOnReversal(client, {
    clientId: input.clientId,
    criterionId: input.criterionId,
    ruleVersionId: input.ruleVersionId,
  });

  return { humanOverrideId, quarantined: quarantine.quarantined, ruleVersionId: quarantine.ruleVersionId };
}
