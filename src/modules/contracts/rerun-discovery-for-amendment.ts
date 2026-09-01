import type pg from 'pg';
import { retireAmendedRules, type AmendedRuleTransition } from './retire-amended-rules.js';
import { detectUnassessableTriggers } from '../discovery/detect-unassessable-triggers.js';
import { detectUnknownChargeCodeTriggers } from '../discovery/detect-unknown-charge-code-triggers.js';
import { detectSuspiciousPassTriggers } from '../discovery/detect-suspicious-pass-triggers.js';

export interface RerunDiscoveryForAmendmentResult {
  transitions: AmendedRuleTransition[];
  affectedAuditRunIds: string[];
  triggersCreated: number;
}

/**
 * P3.D.8: reacts to a recorded contract amendment by deprecating/replacing
 * the ACTIVE rule versions it affects (via the already-tested, P2-era
 * retireAmendedRules) and re-running the audit-run-scoped P3.D discovery
 * detectors (P3.D.1/2/4) against every audit run whose findings cited one of
 * those now-superseded rule versions -- so anomalies get re-detected under
 * the amended contract terms rather than staying pinned to the old ones.
 *
 * No amendment-creation route exists yet -- a sibling capability, matching
 * the precedent that retireAmendedRules/analyzeAmendmentImpact themselves
 * shipped with none -- so this takes an already-recorded amendmentId.
 *
 * Fully idempotent: retireAmendedRules and all three detectors are each
 * idempotent on their own (ON CONFLICT DO NOTHING + re-select), so calling
 * this twice for the same amendment re-derives the same affected audit runs
 * and creates zero duplicate rule versions or triggers.
 */
export async function rerunDiscoveryForAmendment(
  client: pg.PoolClient,
  input: { clientId: string; amendmentId: string },
): Promise<RerunDiscoveryForAmendmentResult> {
  const transitions = await retireAmendedRules(client, input);
  const oldRuleVersionIds = [...new Set(transitions.map((transition) => transition.oldRuleVersionId))];
  if (!oldRuleVersionIds.length) return { transitions, affectedAuditRunIds: [], triggersCreated: 0 };

  const rows = (await client.query<{ audit_run_id: string }>(
    `SELECT DISTINCT audit_run_id FROM charge_finding WHERE client_id = $1 AND rule_version_id = ANY($2::uuid[])
     UNION
     SELECT DISTINCT audit_run_id FROM gate_failure WHERE client_id = $1 AND rule_version_id = ANY($2::uuid[])
     ORDER BY audit_run_id`,
    [input.clientId, oldRuleVersionIds],
  )).rows;
  const affectedAuditRunIds = rows.map((row) => row.audit_run_id);

  let triggersCreated = 0;
  for (const auditRunId of affectedAuditRunIds) {
    const unassessable = await detectUnassessableTriggers(client, { clientId: input.clientId, auditRunId });
    const unknownChargeCode = await detectUnknownChargeCodeTriggers(client, { clientId: input.clientId, auditRunId });
    const suspiciousPass = await detectSuspiciousPassTriggers(client, { clientId: input.clientId, auditRunId });
    triggersCreated += unassessable.createdCount + unknownChargeCode.createdCount + suspiciousPass.createdCount;
  }
  return { transitions, affectedAuditRunIds, triggersCreated };
}
