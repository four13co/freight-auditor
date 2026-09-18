import type pg from 'pg';
import { aggregateCrossAccountPortfolio, type AccountPortfolioBucket } from './aggregate-cross-account-portfolio.js';

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
 * rows -- RLS's `account_id = ANY(app_current_account_ids())` branch still
 * applies, `app_is_internal()` is simply false, so a caller with a normal
 * single-client scope can't use this function to see anyone else's data.
 */
export async function getCrossAccountPortfolio(client: pg.PoolClient): Promise<AccountPortfolioBucket[]> {
  const { rows: claimRows } = await client.query<{
    account_id: string; client_name: string | null; claim_id: string; amount_claimed: string; currency: string | null; status: string;
  }>(
    `SELECT c.account_id, cl.name AS client_name, c.id AS claim_id, c.amount_claimed, c.currency, c.status
       FROM claim c
       JOIN account cl ON cl.id = c.account_id`,
  );

  if (claimRows.length === 0) return [];

  const claimIds = claimRows.map((r) => r.claim_id);
  const { rows: eventRows } = await client.query<{ claim_id: string; amount_recovered: string; currency: string | null }>(
    `SELECT claim_id, amount_recovered, currency FROM recovery_event WHERE claim_id = ANY($1::uuid[])`,
    [claimIds],
  );

  return aggregateCrossAccountPortfolio(
    claimRows.map((r) => ({
      clientId: r.account_id, clientName: r.client_name, claimId: r.claim_id,
      amountClaimed: r.amount_claimed, currency: r.currency, status: r.status,
    })),
    eventRows.map((r) => ({ claimId: r.claim_id, amountRecovered: r.amount_recovered, currency: r.currency })),
  );
}
