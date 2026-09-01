import type pg from 'pg';
import { aggregatePortfolioByClient, type ClientPortfolioBucket } from './aggregate-portfolio-by-client.js';

/**
 * Cross-client portfolio reporting (P5.C.3): fetches EVERY client's claims
 * (no clientId filter, unlike get-carrier-recovery-report.ts and
 * get-portfolio-reconciliation.ts, which are both single-tenant) plus their
 * full recovery_event history, then hands both to the pure
 * aggregatePortfolioByClient for the bucketing/reconciliation math.
 *
 * Deliberately takes no clientId or TenantContext argument -- visibility is
 * enforced structurally by RLS (migration 0009's tenant_isolation policy),
 * which admits every row when `app_is_internal()` is true and NO rows
 * otherwise. The caller MUST run this inside `withTenantTx({ internal: true
 * })` (see registerInternalAnalystAuthPreHandler, tenant-auth.ts) -- calling
 * it under a client-scoped or empty transaction fails closed to an empty
 * result, never to another client's data, which is the property this
 * module's cross-tenant-isolation DB test asserts directly.
 */
export async function getCrossClientPortfolioReport(client: pg.PoolClient): Promise<ClientPortfolioBucket[]> {
  const { rows: claimRows } = await client.query<{
    client_id: string; client_name: string; claim_id: string; amount_claimed: string; currency: string | null; status: string;
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

  return aggregatePortfolioByClient(
    claimRows.map((r) => ({
      clientId: r.client_id, clientName: r.client_name, claimId: r.claim_id,
      amountClaimed: r.amount_claimed, currency: r.currency, status: r.status,
    })),
    eventRows.map((r) => ({ claimId: r.claim_id, amountRecovered: r.amount_recovered, currency: r.currency })),
  );
}
