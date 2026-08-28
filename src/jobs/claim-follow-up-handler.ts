import type pg from 'pg';
import { parseJobPayload, JOB_NAMES } from './contracts.js';
import { generateClaimFollowUp, type GenerateClaimFollowUpResult } from '../modules/claims/generate-claim-follow-up.js';

/**
 * Job wrapper around generateClaimFollowUp (P5.B.2/Master Spec §2.2-style
 * job pattern). Runs the idempotent follow-up generator against a
 * validated, tenant-scoped payload -- no new logic here, matching
 * discover-triggers-handler.ts's own convention of a thin job wrapper over
 * an already-idempotent module function.
 */
export async function handleClaimFollowUpJob(
  db: pg.PoolClient,
  untrustedPayload: unknown,
): Promise<GenerateClaimFollowUpResult> {
  const payload = parseJobPayload(JOB_NAMES.FOLLOW_UP_CLAIM_V1, untrustedPayload);
  return generateClaimFollowUp(db, { clientId: payload.clientId, claimId: payload.claimId });
}
