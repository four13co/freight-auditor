import { Decimal } from 'decimal.js';
import type { ParsedInvoice } from '../ingestion/charge-fact.js';
import { evaluate, verdict, type EvalNode } from '../rule-engine/interpreter.js';
import {
  STANDARD_RUBRIC,
  ENGINE_SPEC_VERSION,
  type ComposedRubric,
  type StandardCriterion,
} from '../rubric-resolver/standard-rubric.js';
import { buildFactBundle, type ContractFacts } from './fact-bundle.js';
import { rubricContentHash } from './snapshot.js';

/**
 * The deterministic gate→score evaluator (Master Spec §5).
 *
 * Pipeline: resolve facts → GATE phase → SCORE phase → scorecard.
 *   - GATE: evaluate every GATING criterion (COLLECT_ALL, not first-fail) so the
 *     carrier kickback lists ALL defects. If any hard gate fails, outcome =
 *     REJECTED_REWORK and the SCORE phase does NOT run (§5 — never score an
 *     invoice that doesn't add up).
 *   - SCORE: only on a clean gate. Each SCORING criterion yields CONFORMED /
 *     VARIANCE / UNASSESSABLE, rolled into a scorecard.
 *
 * The result is a pure function of (invoice, rubric) — no clock, no I/O — so a
 * re-run with the same inputs is byte-identical (§5.4). Reproducibility is
 * pinned by parserVersion + engineSpecVersion + rubricContentHash.
 */

export type Outcome = 'REJECTED_REWORK' | 'SCORED';

export interface GateFailure {
  criterionKey: string;
  defect: string;
  citation?: string;
  evaluatedExpr: EvalNode;
}

export interface ChargeFinding {
  criterionKey: string;
  result: 'CONFORMED' | 'VARIANCE' | 'UNASSESSABLE';
  evaluatedExpr: EvalNode;
  /**
   * The per-criterion $ delta from moneyVarianceDelta() (billed - expected;
   * positive = overcharge, negative = undercharge). Populated only for a
   * VARIANCE finding whose AST bottoms out at a money `compare` node; null
   * for CONFORMED/UNASSESSABLE and for criteria that aren't money comparisons
   * (e.g. STD's pass/fail integrity checks). 86e2v17p5: previously computed
   * here but only accumulated into the scorecard total and discarded
   * per-finding — now threaded through so a per-finding variance_finding row
   * can be derived without re-deriving the delta a second time.
   */
  varianceAmount: string | null;
}

export interface Scorecard {
  conformedCount: number;
  varianceCount: number;
  unassessableCount: number;
  totalOvercharge: string;
  totalUndercharge: string;
}

export interface AuditResult {
  outcome: Outcome;
  gateFailures: GateFailure[]; // the kickback (non-empty iff REJECTED_REWORK)
  findings: ChargeFinding[]; // empty on REJECTED_REWORK (SCORE phase skipped)
  scorecard: Scorecard | null; // null on REJECTED_REWORK
  pins: {
    parserVersion: string;
    engineSpecVersion: string;
    rubricContentHash: string;
  };
}

export function evaluateInvoice(
  invoice: ParsedInvoice,
  rubric: ComposedRubric = STANDARD_RUBRIC,
  contract?: ContractFacts,
): AuditResult {
  const facts = buildFactBundle(invoice, contract);
  const pins = {
    parserVersion: invoice.parserVersion,
    engineSpecVersion: ENGINE_SPEC_VERSION,
    rubricContentHash: rubricContentHash(rubric),
  };

  const gating = orderedCriteria(rubric, 'GATING');
  const scoring = orderedCriteria(rubric, 'SCORING');

  // ---- GATE phase: COLLECT_ALL failed hard gates -------------------------
  const gateFailures: GateFailure[] = [];
  for (const c of gating) {
    const ev = evaluate(c.ast, facts);
    // A gate fails on FAIL. UNASSESSABLE on a hard gate blocks (fails closed):
    // we cannot certify footing/currency if we can't assess it.
    const v = verdict(ev);
    if (v === 'FAIL' || v === 'UNASSESSABLE') {
      gateFailures.push({
        criterionKey: c.criterionKey,
        defect: v === 'UNASSESSABLE' ? `${c.description} (unassessable)` : c.description,
        citation: c.citation,
        evaluatedExpr: ev,
      });
    }
  }

  if (gateFailures.length > 0) {
    // Hard gate failed → REJECTED_REWORK, SCORE phase does NOT run.
    return { outcome: 'REJECTED_REWORK', gateFailures, findings: [], scorecard: null, pins };
  }

  // ---- SCORE phase: only on a clean gate ---------------------------------
  const findings: ChargeFinding[] = [];
  let conformed = 0;
  let variance = 0;
  let unassessable = 0;
  let totalOvercharge = new Decimal(0);
  let totalUndercharge = new Decimal(0);
  for (const c of scoring) {
    const ev = evaluate(c.ast, facts);
    const v = verdict(ev);
    const result = v === 'PASS' ? 'CONFORMED' : v === 'FAIL' ? 'VARIANCE' : 'UNASSESSABLE';
    let delta: Decimal | null = null;
    if (result === 'CONFORMED') conformed += 1;
    else if (result === 'VARIANCE') {
      variance += 1;
      // A dollar-variance criterion's AST bottoms out at a money `compare`
      // (billed vs. expected/contracted) — extract the delta from the
      // evaluated tree itself (§3.2: the evaluated AST IS the explanation,
      // never a separately-computed side value that could drift from it).
      delta = moneyVarianceDelta(ev);
      if (delta !== null) {
        if (delta.isPositive()) totalOvercharge = totalOvercharge.plus(delta);
        else totalUndercharge = totalUndercharge.plus(delta.abs());
      }
    } else unassessable += 1;
    findings.push({
      criterionKey: c.criterionKey,
      result,
      evaluatedExpr: ev,
      varianceAmount: delta === null ? null : delta.toFixed(4),
    });
  }

  const scorecard: Scorecard = {
    conformedCount: conformed,
    varianceCount: variance,
    unassessableCount: unassessable,
    // Phase 1 STANDARD scoring criteria are pass/fail integrity checks (no $
    // rollup); Phase 2's CONTRACT.RATE_VARIANCE is the first criterion to
    // populate these columns for real (reserved for this since evaluate-invoice
    // was written — see the original Phase 1 comment this replaces).
    totalOvercharge: totalOvercharge.toFixed(4),
    totalUndercharge: totalUndercharge.toFixed(4),
  };

  return { outcome: 'SCORED', gateFailures: [], findings, scorecard, pins };
}

function orderedCriteria(rubric: ComposedRubric, kind: StandardCriterion['kind']): StandardCriterion[] {
  return rubric.criteria
    .filter((c) => c.kind === kind)
    .sort((a, b) => a.evalOrder - b.evalOrder || a.criterionKey.localeCompare(b.criterionKey));
}

/**
 * Unwrap `require` wrappers to find the bottom `compare` node (billed vs.
 * expected) and, if both operands evaluated to money, return billed - expected
 * (positive = overcharge, negative = undercharge). Returns null for a
 * criterion that isn't shaped as a money comparison (e.g. STANDARD's
 * pass/fail integrity checks) — those correctly contribute $0 to the rollup.
 */
function moneyVarianceDelta(ev: EvalNode): Decimal | null {
  let node = ev;
  while (node.node.type === 'require' && node.children?.[0]) {
    node = node.children[0];
  }
  if (node.node.type !== 'compare') return null;
  const [left, right] = node.children ?? [];
  if (!left || !right || left.value.kind !== 'money' || right.value.kind !== 'money') return null;
  return new Decimal(left.value.amount).minus(new Decimal(right.value.amount));
}
