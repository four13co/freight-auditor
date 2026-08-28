import type pg from 'pg';
import { parseJobPayload, JOB_NAMES } from './contracts.js';
import { detectUnassessableTriggers } from '../modules/discovery/detect-unassessable-triggers.js';

/**
 * Job wrapper around the discovery-trigger detectors (Master Spec §2.2's
 * discovery loop). Runs each detector's own idempotent insert against a
 * validated, tenant-scoped payload -- no new detection logic here.
 * `detectUnassessableTriggers` (P3.D.1) is the only detector wired in for
 * now; the sibling detectors from P3.D.2/D.3/D.4 (unknown charge-code,
 * extraction quality, suspicious-pass) get added to this same handler once
 * their PR merges to Development, rather than duplicating the job here per
 * detector.
 */
export async function handleDiscoverTriggersJob(
  db: pg.PoolClient,
  untrustedPayload: unknown,
): Promise<{ triggerIds: string[]; createdCount: number }> {
  const payload = parseJobPayload(JOB_NAMES.DISCOVER_TRIGGERS_V1, untrustedPayload);
  return detectUnassessableTriggers(db, { clientId: payload.clientId, auditRunId: payload.auditRunId });
}
