/**
 * Pure composition of a do-not-pay rationale from an audit run's gate
 * failures (P4.B.4). A gate failure means the invoice never reached SCORED
 * (audit_run.outcome = 'REJECTED_REWORK') -- there is no partial amount to
 * withhold, since a currency-gate rejection alone writes zero charge_fact
 * rows, so this decision refuses the whole invoice and never computes an
 * amount.
 */
export interface GateFailureRow {
  id: string;
  defect: string;
  citation: string | null;
}

export interface DoNotPayDecision {
  rationale: string;
  gateFailureIds: string[];
}

export class DoNotPayDecisionError extends Error {
  constructor(readonly code: 'NO_GATE_FAILURES') {
    super('no gate failures to decide against');
    this.name = 'DoNotPayDecisionError';
  }
}

/** Stable ordering (id, never query order) so the composed rationale is deterministic across replays. */
export function composeDoNotPayDecision(rows: readonly GateFailureRow[]): DoNotPayDecision {
  if (rows.length === 0) throw new DoNotPayDecisionError('NO_GATE_FAILURES');
  const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  const rationale = sorted
    .map((r) => (r.citation ? `${r.defect} (${r.citation})` : r.defect))
    .join('; ');
  return { rationale, gateFailureIds: sorted.map((r) => r.id) };
}
