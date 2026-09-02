import type pg from 'pg';

/**
 * One audit_run's scorecard for the client portal (P6.B.1) -- same join
 * shape as the internal getInvoiceScorecard (read-audit-evidence.ts), with
 * an added explicit `client_id` predicate (86e31a9ch/#216 precedent: on top
 * of RLS, not a replacement for it). scorecard.audit_run_id is UNIQUE
 * (migration 0008), so this is always a single row or none -- unlike
 * get-client-scorecard-summary.ts's now-removed client-wide rollup, there
 * is no cross-currency blending question here at all.
 *
 * LEFT JOINs scorecard (not an inner join) because an audit_run can exist
 * without one yet (REJECTED_REWORK: the hard gate failed, so the SCORE
 * phase never ran -- evaluate-invoice.ts's own Outcome type, `scorecard:
 * null` on that branch) -- the caller still gets the invoice/outcome
 * context back, with the count/total fields null, matching
 * InvoiceScorecard's own nullable shape.
 */
export interface ClientAuditRunScorecard {
  auditRunId: string;
  invoiceId: string;
  invoiceNumber: string | null;
  outcome: string;
  conformedCount: number | null;
  varianceCount: number | null;
  unassessableCount: number | null;
  totalOvercharge: string | null;
  totalUndercharge: string | null;
  currency: string | null;
}

/**
 * Runs inside the caller's withTenantTx -- RLS is FORCE-enabled on
 * audit_run (migration 0009), so a query issued outside that transaction
 * silently returns zero rows, never an error. Returns null when no
 * audit_run with this id is visible to this clientId -- doesn't
 * distinguish "doesn't exist" from "belongs to another client", matching
 * get-claim-detail.ts's own not-found convention.
 */
export async function getClientAuditRunScorecard(
  client: pg.PoolClient,
  clientId: string,
  auditRunId: string,
): Promise<ClientAuditRunScorecard | null> {
  const { rows } = await client.query<{
    audit_run_id: string; invoice_id: string; invoice_number: string | null; outcome: string;
    conformed_count: number | null; variance_count: number | null; unassessable_count: number | null;
    total_overcharge: string | null; total_undercharge: string | null; currency: string | null;
  }>(
    `SELECT ar.id AS audit_run_id, i.id AS invoice_id, i.invoice_number, ar.outcome,
            sc.conformed_count, sc.variance_count, sc.unassessable_count,
            sc.total_overcharge, sc.total_undercharge, sc.currency
       FROM audit_run ar
       JOIN invoice i ON i.id = ar.invoice_id
       LEFT JOIN scorecard sc ON sc.audit_run_id = ar.id
      WHERE ar.id = $1 AND ar.client_id = $2`,
    [auditRunId, clientId],
  );

  const r = rows[0];
  if (!r) return null;

  return {
    auditRunId: r.audit_run_id,
    invoiceId: r.invoice_id,
    invoiceNumber: r.invoice_number,
    outcome: r.outcome,
    conformedCount: r.conformed_count === null ? null : Number(r.conformed_count),
    varianceCount: r.variance_count === null ? null : Number(r.variance_count),
    unassessableCount: r.unassessable_count === null ? null : Number(r.unassessable_count),
    totalOvercharge: r.total_overcharge,
    totalUndercharge: r.total_undercharge,
    currency: r.currency,
  };
}
