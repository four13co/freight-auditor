import type { StandardCriterion, ComposedRubric } from './standard-rubric.js';
import { STANDARD_RUBRIC } from './standard-rubric.js';

/**
 * The CONTRACT-tier rubric slice (Master Spec §12 Phase 2, item 86e25te91).
 *
 * This is NOT the full three-tier cascade resolver (§3.0's override-verb
 * composition over rubric/rubric_version/criterion_membership) — that stays
 * deferred per the task's own rabbit holes. This is a minimal, hand-authored
 * CONTRACT tier composed the same way Phase 1 hand-authored STANDARD: a fixed
 * array of criteria, appended to STANDARD's GATING criteria unchanged. A
 * CONTRACT-scoped audit run resolves STANDARD + this one new SCORING
 * criterion together; a STANDARD-only run (no contract) is unaffected.
 *
 * `CONTRACT.RATE_VARIANCE` is FIRM_RULE like STANDARD's criteria (no
 * AI-authored hardness yet — that's Phase 3). Absolute-dollar tolerance,
 * matching the footing tolerance's style (a criterion parameter, not a
 * magic constant).
 */

export const CONTRACT_RESOLVER_VERSION = 'contract-resolver-v1';

/** Absolute-dollar tolerance for the linehaul rate-variance check. */
export const RATE_VARIANCE_TOLERANCE = '0.01';

const RATE_VARIANCE_CRITERION: StandardCriterion = {
  criterionKey: 'CONTRACT.RATE_VARIANCE',
  kind: 'SCORING',
  evalOrder: 200,
  description: 'Billed linehaul charge matches the contracted rate within tolerance.',
  ast: {
    type: 'require',
    key: 'billed_linehaul',
    then: {
      type: 'require',
      key: 'contract_linehaul_rate',
      then: {
        type: 'compare',
        op: 'approx',
        tolerance: RATE_VARIANCE_TOLERANCE,
        left: { type: 'fact', key: 'billed_linehaul' },
        right: { type: 'fact', key: 'contract_linehaul_rate' },
      },
    },
  },
};

/**
 * Compose STANDARD + CONTRACT for a contract-scoped audit run. STANDARD's
 * GATING criteria are unchanged (cascade, not override) and its two SCORING
 * criteria remain; CONTRACT.RATE_VARIANCE is appended.
 */
export const CONTRACT_RUBRIC: ComposedRubric = {
  resolverVersion: CONTRACT_RESOLVER_VERSION,
  criteria: [...STANDARD_RUBRIC.criteria, RATE_VARIANCE_CRITERION],
};
