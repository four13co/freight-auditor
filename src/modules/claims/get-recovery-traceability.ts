import type pg from 'pg';
import { checkRecoveryTraceability, type RecoveryTraceabilityResult } from './check-recovery-traceability.js';

export class GetRecoveryTraceabilityError extends Error {
  constructor(readonly code: 'RECOVERY_EVENT_NOT_FOUND') {
    super(code.toLowerCase().replace(/_/g, ' '));
    this.name = 'GetRecoveryTraceabilityError';
  }
}

/**
 * Reconciliation read for one recovery_event (P5.A.7): resolves whether it
 * traces to a cited clause or rate cell, directly via its own
 * variance_finding_id, or indirectly via its claim's dispute's
 * dispute_line findings. Read-only, same convention as
 * get-derived-claim-status.ts (#175) and get-claim-currency-consistency.ts
 * (#176).
 */
export async function getRecoveryTraceability(
  client: pg.PoolClient,
  clientId: string,
  recoveryEventId: string,
): Promise<RecoveryTraceabilityResult> {
  const { rows: eventRows } = await client.query<{ claim_id: string | null; variance_finding_id: string | null }>(
    `SELECT claim_id, variance_finding_id FROM recovery_event WHERE client_id = $1 AND id = $2`,
    [clientId, recoveryEventId],
  );
  const eventRow = eventRows[0];
  if (!eventRow) throw new GetRecoveryTraceabilityError('RECOVERY_EVENT_NOT_FOUND');

  if (eventRow.variance_finding_id) {
    const { rows } = await client.query<{ has_citation: boolean }>(
      `SELECT (clause_id IS NOT NULL OR rate_cell_id IS NOT NULL) AS has_citation
         FROM variance_finding WHERE client_id = $1 AND id = $2`,
      [clientId, eventRow.variance_finding_id],
    );
    const hasCitation = rows[0]?.has_citation ?? false;
    return checkRecoveryTraceability(recoveryEventId, eventRow.variance_finding_id, hasCitation, []);
  }

  if (!eventRow.claim_id) {
    return checkRecoveryTraceability(recoveryEventId, null, null, []);
  }

  const { rows: disputeLineFindings } = await client.query<{ variance_finding_id: string; has_citation: boolean }>(
    `SELECT vf.id AS variance_finding_id, (vf.clause_id IS NOT NULL OR vf.rate_cell_id IS NOT NULL) AS has_citation
       FROM claim c
       JOIN dispute_line dl ON dl.dispute_id = c.dispute_id AND dl.client_id = c.client_id
       JOIN variance_finding vf ON vf.id = dl.variance_finding_id AND vf.client_id = c.client_id
      WHERE c.client_id = $1 AND c.id = $2`,
    [clientId, eventRow.claim_id],
  );

  return checkRecoveryTraceability(
    recoveryEventId,
    null,
    null,
    disputeLineFindings.map((r) => ({ varianceFindingId: r.variance_finding_id, hasCitation: r.has_citation })),
  );
}
