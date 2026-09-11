import type pg from 'pg';

/**
 * 86e37r2rt: one row of the internal invoice list. Runs inside the caller's
 * withTenantReadTx -- RLS is FORCE-enabled on both `invoice` and
 * `charge_fact` (migration 0009), so a query issued outside that transaction
 * silently returns zero rows, never an error -- same convention as
 * list-findings.ts.
 */
export interface InvoiceRow {
  id: string;
  invoiceNumber: string | null;
  carrierName: string | null;
  transactionSet: string;
  status: string;
  currency: string | null;
  createdAt: Date;
  /** SUM(charge_fact.amount) for this invoice; null when no charge_fact rows exist. */
  billedTotal: string | null;
}

export interface ListInvoicesOptions {
  carrier?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 50;

/**
 * List invoice rows joined to carrier + their summed charge_fact.amount, for
 * the tenant scope already bound by the caller's withTenantReadTx.
 *
 * No client_id filter is applied here -- RLS (forced on both invoice and
 * charge_fact) already restricts visible rows to the transaction's tenant
 * scope, same as listFindings' own documented convention.
 */
export async function listInvoices(
  client: pg.PoolClient,
  options: ListInvoicesOptions = {},
): Promise<InvoiceRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.carrier) {
    params.push(options.carrier);
    conditions.push(`carrier.name = $${params.length}`);
  }
  if (options.status) {
    params.push(options.status);
    conditions.push(`invoice.status = $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options.limit ?? DEFAULT_LIMIT;
  const offset = options.offset ?? 0;
  params.push(limit, offset);

  const result = await client.query<{
    id: string;
    invoice_number: string | null;
    carrier_name: string | null;
    transaction_set: string;
    status: string;
    currency: string | null;
    created_at: Date;
    billed_total: string | null;
  }>(
    `SELECT
       invoice.id,
       invoice.invoice_number,
       carrier.name AS carrier_name,
       invoice.transaction_set,
       invoice.status,
       invoice.currency,
       invoice.created_at,
       charge_totals.billed_total
     FROM invoice
     LEFT JOIN carrier ON carrier.id = invoice.carrier_id
     -- LEFT JOIN LATERAL (not a plain GROUP BY) so an invoice with zero
     -- charge_fact rows still surfaces with billedTotal NULL, matching
     -- list-findings.ts's own "missing charge reference -> null, not a
     -- fabricated 0" convention (86e2uutk8) rather than silently dropping it
     -- (a plain JOIN) or forcing a GROUP BY across every other selected
     -- column.
     LEFT JOIN LATERAL (
       SELECT SUM(charge_fact.amount) AS billed_total
       FROM charge_fact
       WHERE charge_fact.invoice_id = invoice.id
     ) charge_totals ON true
     ${where}
     ORDER BY invoice.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return result.rows.map((row) => ({
    id: row.id,
    invoiceNumber: row.invoice_number,
    carrierName: row.carrier_name,
    transactionSet: row.transaction_set,
    status: row.status,
    currency: row.currency,
    createdAt: row.created_at,
    billedTotal: row.billed_total,
  }));
}
