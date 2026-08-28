import type pg from 'pg';
import { parseJobPayload, JOB_NAMES } from './contracts.js';
import { generateClaimEscalation, type GenerateClaimEscalationResult } from '../modules/claims/generate-claim-escalation.js';

/**
 * Job wrapper around generateClaimEscalation (P5.B.3), matching
 * claim-follow-up-handler.ts's (#179) and discover-triggers-handler.ts's
 * (#158) own thin-wrapper convention -- no new logic here.
 */
export async function handleClaimEscalationJob(
  db: pg.PoolClient,
  untrustedPayload: unknown,
): Promise<GenerateClaimEscalationResult> {
  const payload = parseJobPayload(JOB_NAMES.ESCALATE_CLAIM_V1, untrustedPayload);
  return generateClaimEscalation(db, { clientId: payload.clientId, claimId: payload.claimId });
}
