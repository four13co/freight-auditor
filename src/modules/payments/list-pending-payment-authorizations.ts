import type pg from 'pg';

/**
 * One row of the analyst payment-approval queue (P4.B.6): an audit run
 * currently sitting on the platform's default 'hold' payment_gate_decision
 * (P4.B.2) with no later analyst 'approve' (P4.B.5), and not otherwise
 * resolved by a 'short_pay' (P4.B.3) or 'do_not_pay' (P4.B.4) decision.
 *
 * heldAt / rationale come from the 'hold' decision itself, not from the
 * audit run -- this is a queue of decisions awaiting resolution, not of
 * audit runs, mirroring list-gate-failures.ts's row-per-decision shape.
 */
export interface PendingPaymentAuthorizationRow {
  auditRunId: string;
  invoiceId: string;
  invoiceNumber: string | null;
  carrierName: string | null;
  currency: string | null;
  heldAt: Date;
  rationale: string | null;
}

export interface ListPendingPaymentAuthorizationsOptions {
  /** Present so a caller can pass its TenantContext straight through if useful; not used to filter — RLS already scopes rows. */
  clientIds?: string[];
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 50;

/**
 * List audit runs awaiting an analyst's approve/hold decision -- payment
 * defaults remain hold-then-approve (Master Spec §10), so this is exactly
 * the set of invoices the "hold" default has parked pending a human call.
 *
 * A NOT EXISTS against every other payment_gate_action, rather than a
 * "latest decision" window function, because payment_gate_decision has at
 * most ONE row per (client_id, audit_run_id, action) (0052's
 * payment_gate_decision_run_action_uk) -- there is no chronological
 * sequence of holds to rank, only a fixed set of independent action rows
 * per audit run to check for.
 *
 * Ordered oldest-hold-first (FIFO triage) -- the item's own generic
 * acceptance criteria don't specify an order; this is the same assumption
 * list-gate-failures.ts makes the opposite way (newest-first, for a "what
 * just broke" panel) and is called out as such in the PR body.
 */
export async function listPendingPaymentAuthorizations(
  client: pg.PoolClient,
  options: ListPendingPaymentAuthorizationsOptions = {},
): Promise<PendingPaymentAuthorizationRow[]> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const offset = options.offset ?? 0;

  const result = await client.query<{
    audit_run_id: string;
    invoice_id: string;
    invoice_number: string | null;
    carrier_name: string | null;
    currency: string | null;
    held_at: Date;
    rationale: string | null;
  }>(
    `SELECT
       hold.audit_run_id,
       invoice.id AS invoice_id,
       invoice.invoice_number,
       carrier.name AS carrier_name,
       invoice.currency,
       hold.recorded_at AS held_at,
       hold.rationale
     FROM payment_gate_decision hold
     JOIN audit_run ON audit_run.id = hold.audit_run_id
     JOIN invoice ON invoice.id = audit_run.invoice_id
     LEFT JOIN carrier ON carrier.id = invoice.carrier_id
     WHERE hold.action = 'hold'
       AND NOT EXISTS (
         SELECT 1 FROM payment_gate_decision resolved
         WHERE resolved.audit_run_id = hold.audit_run_id
           AND resolved.action IN ('approve', 'short_pay', 'do_not_pay')
       )
     ORDER BY hold.recorded_at ASC, hold.audit_run_id
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );

  return result.rows.map((row) => ({
    auditRunId: row.audit_run_id,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    carrierName: row.carrier_name,
    currency: row.currency,
    heldAt: row.held_at,
    rationale: row.rationale,
  }));
}
