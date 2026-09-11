import type pg from 'pg';

/**
 * One row of the internal-analyst invoice list (86e37r2rt). Runs inside the
 * caller's withTenantReadTx -- RLS is FORCE-enabled on invoice/charge_fact
 * (migration 0009), so this always executes under a resolved
 * internal-analyst context (registerInternalAnalystAuthPreHandler,
 * portfolio-routes.ts's own precedent), giving cross-client visibility by
 * design, not a per-tenant scope.
 */
export interface InvoiceRow {
  id: string;
  invoiceNumber: string | null;
  carrierName: string | null;
  transactionSet: string;
  status: string;
  currency: string | null;
  createdAt: Date;
  /** Sum of charge_fact.amount for this invoice; '0.0000' when it has no charges yet, never null. */
  billedTotal: string;
}

export interface ListInvoicesOptions {
  carrier?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 50;

/**
 * List invoice rows with their billed total (sum of charge_fact.amount,
 * grouped) and carrier name, for the tenant scope already bound by the
 * caller's withTenantReadTx.
 *
 * carrier/status filter on the outer invoice row (carrier.name, invoice.status)
 * -- the same param shape as list-findings.ts's carrier/status filters, for
 * consistency (this item's own Solution).
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
    billed_total: string;
  }>(
    `SELECT
       invoice.id,
       invoice.invoice_number,
       carrier.name AS carrier_name,
       invoice.transaction_set,
       invoice.status,
       invoice.currency,
       invoice.created_at,
       COALESCE(SUM(charge_fact.amount), 0)::numeric(18,4) AS billed_total
     FROM invoice
     LEFT JOIN carrier ON carrier.id = invoice.carrier_id
     LEFT JOIN charge_fact ON charge_fact.invoice_id = invoice.id
     ${where}
     GROUP BY invoice.id, carrier.name
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
