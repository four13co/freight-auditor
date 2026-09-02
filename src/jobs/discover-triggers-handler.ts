import type pg from 'pg';
import { parseJobPayload, JOB_NAMES } from './contracts.js';
import { detectUnassessableTriggers } from '../modules/discovery/detect-unassessable-triggers.js';
import { detectUnknownChargeCodeTriggers } from '../modules/discovery/detect-unknown-charge-code-triggers.js';
import { detectSuspiciousPassTriggers } from '../modules/discovery/detect-suspicious-pass-triggers.js';

/**
 * P3.D.5: an idempotent job wrapping the audit-run-scoped P3.D discovery
 * detectors (parse the untrusted payload, dispatch to the already-audited
 * domain function(s), let them fail closed). Registers no new idempotency
 * logic -- `deterministicJobId` gives
 * this job name its own domain automatically (existing `job-enqueue.test.ts`
 * coverage).
 *
 * Wires in every P3.D detector that is audit-run-scoped and merged today:
 * P3.D.1 (unassessable), P3.D.2 (unknown charge code), P3.D.4 (suspicious
 * pass). P3.D.3 (extraction quality) is source-document-scoped -- extraction
 * runs independent of any audit run -- and lives on an unmerged PR (#225) as
 * of this task; wiring it in now would couple this independently-buildable
 * job to that PR landing first, the same coupling PR #158 explicitly avoided.
 * Follow-up once #225 merges: widen the payload to a discriminated union and
 * dispatch EXTRACTION-scoped jobs to detectExtractionQualityTriggers.
 *
 * No queue changes needed in policies.ts -- retry/backoff/DLQ apply via its
 * existing Object.values(JOB_NAMES) iteration.
 */
export async function handleDiscoverTriggersJob(
  db: pg.PoolClient,
  untrustedPayload: unknown,
) {
  const payload = parseJobPayload(JOB_NAMES.DISCOVER_TRIGGERS_V1, untrustedPayload);

  const unassessable = await detectUnassessableTriggers(db, { clientId: payload.clientId, auditRunId: payload.auditRunId });
  const unknownChargeCode = await detectUnknownChargeCodeTriggers(db, { clientId: payload.clientId, auditRunId: payload.auditRunId });
  const suspiciousPass = await detectSuspiciousPassTriggers(db, { clientId: payload.clientId, auditRunId: payload.auditRunId });
  return { unassessable, unknownChargeCode, suspiciousPass };
}
