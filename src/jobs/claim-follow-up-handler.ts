import type pg from 'pg';
import { generateClaimFollowUp } from '../modules/claims/generate-claim-follow-up.js';
import { parseJobPayload, JOB_NAMES } from './contracts.js';

export async function handleClaimFollowUpJob(db: pg.PoolClient, untrustedPayload: unknown) {
  const payload = parseJobPayload(JOB_NAMES.FOLLOW_UP_CLAIM_V1, untrustedPayload);
  return generateClaimFollowUp(db, payload.clientId, payload.claimId);
}
