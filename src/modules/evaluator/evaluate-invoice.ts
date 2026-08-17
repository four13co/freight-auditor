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
  /** billed - expected for a VARIANCE finding; null otherwise (86e2v17p5 -- persistAuditRun reads this directly rather than re-deriving it). */
  varianceAmount: string | null;
  /** The money comparison's currency for a VARIANCE finding; null otherwise. */
  currency: string | null;
  /** OVERCHARGE/UNDERCHARGE for a VARIANCE finding; INTEGRITY_ONLY for CONFORMED/UNASSESSABLE or any criterion with no money comparison. */
  direction: 'OVERCHARGE' | 'UNDERCHARGE' | 'INTEGRITY_ONLY';
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
    // A dollar-variance criterion's AST bottoms out at a money `compare`
    // (billed vs. expected/contracted) — extract the delta from the
    // evaluated tree itself (§3.2: the evaluated AST IS the explanation,
    // never a separately-computed side value that could drift from it).
    // Computed regardless of result so a CONFORMED/UNASSESSABLE finding on a
    // money-comparison criterion still reports null (not just skipped),
    // distinct from a non-money criterion which is also null but for a
    // different reason (moneyVarianceDelta returns null either way).
    const moneyDelta = moneyVarianceDelta(ev);
    let varianceAmount: string | null = null;
    let currency: string | null = null;
    let direction: ChargeFinding['direction'] = 'INTEGRITY_ONLY';
    if (result === 'CONFORMED') conformed += 1;
    else if (result === 'VARIANCE') {
      variance += 1;
      if (moneyDelta !== null) {
        const { delta, currency: deltaCurrency } = moneyDelta;
        if (delta.isPositive()) totalOvercharge = totalOvercharge.plus(delta);
        else totalUndercharge = totalUndercharge.plus(delta.abs());
        varianceAmount = delta.toFixed(4);
        currency = deltaCurrency;
        direction = delta.isNegative() ? 'UNDERCHARGE' : 'OVERCHARGE';
      }
    } else unassessable += 1;
    findings.push({ criterionKey: c.criterionKey, result, evaluatedExpr: ev, varianceAmount, currency, direction });
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
 * (positive = overcharge, negative = undercharge) plus the shared currency.
 * Returns null for a criterion that isn't shaped as a money comparison (e.g.
 * STANDARD's pass/fail integrity checks) — those correctly contribute $0 to
 * the rollup. The two operands' currencies are assumed equal here: a
 * criterion reaches `compare` only after its `require` gate on a
 * currencies-match fact already passed (e.g. `linehaul_currencies_match`) --
 * a mismatch resolves the whole criterion UNASSESSABLE before `compare` ever
 * evaluates, per fact-bundle.ts's 86e25ug1p handling.
 */
function moneyVarianceDelta(ev: EvalNode): { delta: Decimal; currency: string } | null {
  let node = ev;
  while (node.node.type === 'require' && node.children?.[0]) {
    node = node.children[0];
  }
  if (node.node.type !== 'compare') return null;
  const [left, right] = node.children ?? [];
  if (!left || !right || left.value.kind !== 'money' || right.value.kind !== 'money') return null;
  const delta = new Decimal(left.value.amount).minus(new Decimal(right.value.amount));
  return { delta, currency: left.value.currency };
}
