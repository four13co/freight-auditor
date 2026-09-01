import type pg from 'pg';

/**
 * One row of the client portal's invoice list (P6.B.1). Runs inside the
 * caller's withTenantTx -- RLS is FORCE-enabled on invoice (migration
 * 0009), so a query issued outside that transaction silently returns zero
 * rows, never an error, matching list-claims.ts's own convention.
 * `clientId` is an explicit predicate on top of RLS, not a replacement for
 * it -- same reasoning as list-claims.ts/get-claim-detail.ts
 * (86e31a9ch/#216 precedent): a caller that ever resolves a broader scope
 * than intended still can't leak another tenant's invoices through this
 * function.
 */
export interface ClientInvoiceRow {
  id: string;
  invoiceNumber: string | null;
  carrierId: string | null;
  carrierName: string | null;
  currency: string | null;
  status: string;
  createdAt: Date;
}

export interface ListClientInvoicesOptions {
  status?: string;
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 50;

/**
 * List invoice rows for the given tenant scope, newest-first
 * (created_at DESC) -- no configurable sort key yet, matching
 * list-claims.ts's own precedent of adding one only once a requirement
 * surfaces. Carrier name is joined in for display (client_viewer never
 * sees raw carrier ids), a LEFT JOIN since invoice.carrier_id is nullable.
 */
export async function listClientInvoices(
  client: pg.PoolClient,
  clientId: string,
  options: ListClientInvoicesOptions = {},
): Promise<ClientInvoiceRow[]> {
  const conditions: string[] = ['i.client_id = $1'];
  const params: unknown[] = [clientId];

  if (options.status) {
    params.push(options.status);
    conditions.push(`i.status = $${params.length}`);
  }

  const limit = options.limit ?? DEFAULT_LIMIT;
  const offset = options.offset ?? 0;

  params.push(limit, offset);
  const { rows } = await client.query<{
    id: string; invoice_number: string | null; carrier_id: string | null; carrier_name: string | null;
    currency: string | null; status: string; created_at: Date;
  }>(
    `SELECT i.id, i.invoice_number, i.carrier_id, c.name AS carrier_name, i.currency, i.status, i.created_at
       FROM invoice i
       LEFT JOIN carrier c ON c.id = i.carrier_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY i.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return rows.map((r) => ({
    id: r.id,
    invoiceNumber: r.invoice_number,
    carrierId: r.carrier_id,
    carrierName: r.carrier_name,
    currency: r.currency,
    status: r.status,
    createdAt: r.created_at,
  }));
}
