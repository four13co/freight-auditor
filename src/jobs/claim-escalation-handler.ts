import type pg from 'pg';
import { generateClaimEscalation } from '../modules/claims/generate-claim-escalation.js';
import { parseJobPayload, JOB_NAMES } from './contracts.js';

export async function handleClaimEscalationJob(db: pg.PoolClient, untrustedPayload: unknown) {
  const payload = parseJobPayload(JOB_NAMES.ESCALATE_CLAIM_V1, untrustedPayload);
  return generateClaimEscalation(db, payload.clientId, payload.claimId);
}
