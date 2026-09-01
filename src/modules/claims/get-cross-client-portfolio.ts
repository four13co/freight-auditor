import type pg from 'pg';
import { aggregateCrossClientPortfolio, type ClientPortfolioBucket } from './aggregate-cross-client-portfolio.js';

/**
 * Cross-client portfolio reporting for internal analysts (P5.C.3). No
 * clientId input at all -- deliberately unscoped, relying entirely on RLS
 * (migration 0009's `app_is_internal()` branch) to admit every client's
 * rows when this runs inside an `{ internal: true }` transaction.
 *
 * The caller (portfolio-routes.ts) is responsible for only ever invoking
 * this behind an internal-analyst-authorized transaction. This function
 * itself stays safe even if a future caller gets that wrong:
 * get-cross-client-portfolio.db.test.ts proves that under a NON-internal
 * (regular tenant) transaction, this query returns only that tenant's own
 * rows -- RLS's `client_id = ANY(app_current_client_ids())` branch still
 * applies, `app_is_internal()` is simply false, so a caller with a normal
 * single-client scope can't use this function to see anyone else's data.
 */
export async function getCrossClientPortfolio(client: pg.PoolClient): Promise<ClientPortfolioBucket[]> {
  const { rows: claimRows } = await client.query<{
    client_id: string; client_name: string | null; claim_id: string; amount_claimed: string; currency: string | null; status: string;
  }>(
    `SELECT c.client_id, cl.name AS client_name, c.id AS claim_id, c.amount_claimed, c.currency, c.status
       FROM claim c
       JOIN client cl ON cl.id = c.client_id`,
  );

  if (claimRows.length === 0) return [];

  const claimIds = claimRows.map((r) => r.claim_id);
  const { rows: eventRows } = await client.query<{ claim_id: string; amount_recovered: string; currency: string | null }>(
    `SELECT claim_id, amount_recovered, currency FROM recovery_event WHERE claim_id = ANY($1::uuid[])`,
    [claimIds],
  );

  return aggregateCrossClientPortfolio(
    claimRows.map((r) => ({
      clientId: r.client_id, clientName: r.client_name, claimId: r.claim_id,
      amountClaimed: r.amount_claimed, currency: r.currency, status: r.status,
    })),
    eventRows.map((r) => ({ claimId: r.claim_id, amountRecovered: r.amount_recovered, currency: r.currency })),
  );
}
