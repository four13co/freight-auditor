import type pg from 'pg';

/**
 * One currency's rolled-up scorecard totals for the client portal (P6.B.1).
 * Summed across every audit_run scorecard row this tenant has (migration
 * 0008's per-run rollup, §6.7) -- grouped by currency rather than summed
 * across currencies, matching PortfolioReport's own currency-safety
 * convention (get-cross-client-portfolio.ts/aggregate-cross-client-
 * portfolio.ts): a client billed in both USD and CAD must never see a
 * single blended total that silently mixes the two.
 */
export interface ClientScorecardSummaryBucket {
  currency: string | null;
  runCount: number;
  conformedCount: number;
  varianceCount: number;
  unassessableCount: number;
  totalOvercharge: string;
  totalUndercharge: string;
}

/**
 * Runs inside the caller's withTenantTx -- RLS is FORCE-enabled on
 * scorecard (migration 0009), so a query issued outside that transaction
 * silently returns zero rows, never an error, matching list-claims.ts's own
 * convention. `clientId` is an explicit predicate on top of RLS, not a
 * replacement for it (86e31a9ch/#216 precedent).
 */
export async function getClientScorecardSummary(
  client: pg.PoolClient,
  clientId: string,
): Promise<ClientScorecardSummaryBucket[]> {
  const { rows } = await client.query<{
    currency: string | null; run_count: string; conformed_count: string; variance_count: string;
    unassessable_count: string; total_overcharge: string; total_undercharge: string;
  }>(
    `SELECT currency,
            COUNT(*) AS run_count,
            COALESCE(SUM(conformed_count), 0) AS conformed_count,
            COALESCE(SUM(variance_count), 0) AS variance_count,
            COALESCE(SUM(unassessable_count), 0) AS unassessable_count,
            COALESCE(SUM(total_overcharge), 0) AS total_overcharge,
            COALESCE(SUM(total_undercharge), 0) AS total_undercharge
       FROM scorecard
      WHERE client_id = $1
      GROUP BY currency
      ORDER BY currency NULLS LAST`,
    [clientId],
  );

  return rows.map((r) => ({
    currency: r.currency,
    runCount: Number(r.run_count),
    conformedCount: Number(r.conformed_count),
    varianceCount: Number(r.variance_count),
    unassessableCount: Number(r.unassessable_count),
    totalOvercharge: r.total_overcharge,
    totalUndercharge: r.total_undercharge,
  }));
}
