import type pg from 'pg';

/** Resolve cross-document history before pure evaluation; RLS binds tenant scope. */
export async function detectDuplicateInvoice(
  client: pg.PoolClient,
  clientId: string,
  invoiceNumber: string | undefined,
  transactionSet: string,
): Promise<boolean | undefined> {
  const normalized = invoiceNumber?.trim();
  if (!normalized) return undefined;
  // Serialize identical business keys until the surrounding transaction
  // commits, preventing two concurrent first-seen invoices both passing.
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `${clientId}\0${transactionSet}\0${normalized.toLowerCase()}`,
  ]);
  const result = await client.query(
    `SELECT 1 FROM invoice
     WHERE client_id = $1 AND transaction_set = $2
       AND lower(btrim(invoice_number)) = lower($3)
     LIMIT 1`,
    [clientId, transactionSet, normalized],
  );
  return (result.rowCount ?? 0) > 0;
}
