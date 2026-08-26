import type pg from 'pg';

/**
 * One row of the gate-failures list (86e2v17xn). A REJECTED_REWORK audit
 * run's kickback -- structurally distinct from a FindingRow (list-findings.ts):
 * no billed/expected/variance amounts exist, since the invoice was rejected
 * before the SCORE phase ever ran. One audit_run can have MULTIPLE
 * gate_failure rows (COLLECT_ALL -- every failing gate criterion is recorded,
 * not just the first), so this returns one row per gate_failure, not one per
 * audit_run; a caller wanting a per-invoice grouping does that itself.
 *
 * ruleDescription is deliberately omitted here (unlike list-findings.ts):
 * gate_failure.criterion_id is currently always NULL (persist.ts never calls
 * 86e2v2dh1's resolver -- confirmed empirically, same gap noted in PR #92),
 * so a criterion_version join would only ever resolve to null. defect/
 * citation already carry the human-readable explanation directly on the row
 * (persist.ts writes both verbatim from the evaluator's GateFailure), so
 * there's nothing a criterion join would add today.
 */
export interface GateFailureRow {
  id: string;
  auditRunId: string;
  invoiceNumber: string | null;
  carrierName: string | null;
  defect: string;
  citation: string | null;
  recordedAt: Date;
  criterionKey: string;
  evaluatedExpr: unknown;
  clauseReference: string | null;
  sourceDocumentId: string | null;
  transportDocumentId: string | null;
}

export interface ListGateFailuresOptions {
  /** Present so a caller can pass its TenantContext straight through if useful; not used to filter — RLS already scopes rows. */
  clientIds?: string[];
  carrier?: string;
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 50;

/**
 * List gate_failure rows for REJECTED_REWORK audit runs, joined to their
 * invoice/carrier, for the tenant scope already bound by the caller's
 * withTenantTx.
 *
 * Deliberately a SEPARATE query from listFindings, not a UNION or a shared
 * base -- the row shapes diverge enough (no charge_fact_id, no direction, no
 * variance_amount) that mixing them would produce a query whose column
 * meaning depends on which "kind" of row is being read (86e2v17xn's own
 * explicit rabbit hole).
 */
export async function listGateFailures(
  client: pg.PoolClient,
  options: ListGateFailuresOptions = {},
): Promise<GateFailureRow[]> {
  const conditions: string[] = [`audit_run.outcome = 'REJECTED_REWORK'`];
  const params: unknown[] = [];

  if (options.carrier) {
    params.push(options.carrier);
    conditions.push(`carrier.name = $${params.length}`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const offset = options.offset ?? 0;
  params.push(limit, offset);

  const result = await client.query<{
    id: string;
    audit_run_id: string;
    invoice_number: string | null;
    carrier_name: string | null;
    defect: string;
    citation: string | null;
    recorded_at: Date;
    criterion_key: string;
    evaluated_expr: unknown;
    clause_ref: string | null;
    source_document_id: string | null;
    transport_document_id: string | null;
  }>(
    `SELECT
       gate_failure.id,
       gate_failure.audit_run_id,
       invoice.invoice_number,
       carrier.name AS carrier_name,
       gate_failure.defect,
       gate_failure.citation,
       gate_failure.recorded_at
       , criterion.criterion_key, gate_failure.evaluated_expr, contract_clause.clause_ref,
       gate_failure.source_document_id, gate_failure.transport_document_id
     FROM gate_failure
     JOIN audit_run ON audit_run.id = gate_failure.audit_run_id
     JOIN invoice ON invoice.id = audit_run.invoice_id
     LEFT JOIN carrier ON carrier.id = invoice.carrier_id
     JOIN criterion ON criterion.id = gate_failure.criterion_id
     LEFT JOIN contract_clause ON contract_clause.id = gate_failure.clause_id
     ${where}
     ORDER BY gate_failure.recorded_at DESC, gate_failure.id
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return result.rows.map((row) => ({
    id: row.id,
    auditRunId: row.audit_run_id,
    invoiceNumber: row.invoice_number,
    carrierName: row.carrier_name,
    defect: row.defect,
    citation: row.citation,
    recordedAt: row.recorded_at,
    criterionKey: row.criterion_key,
    evaluatedExpr: row.evaluated_expr,
    clauseReference: row.clause_ref,
    sourceDocumentId: row.source_document_id,
    transportDocumentId: row.transport_document_id,
  }));
}
