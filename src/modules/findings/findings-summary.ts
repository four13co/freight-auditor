import type pg from 'pg';

/**
 * The four dashboard KPI-row aggregates (86e2u7j0j). Runs inside the caller's
 * withTenantTx -- RLS is FORCE-enabled on variance_finding/recovery_event, so a
 * query issued outside that transaction silently returns zero rows, never an
 * error (same convention as listFindings).
 *
 * Status mapping (the item's shape names the four KPIs but doesn't pin the
 * status filters -- this is the deterministic choice made here, not left
 * ambiguous):
 *   recoverableOpen      -- variance_finding.status = 'open' (still actionable,
 *                            not yet escalated or resolved)
 *   flaggedToday         -- variance_finding created since local midnight today
 *   withCarriers          -- status IN ('queued_for_dispute', 'disputed') --
 *                            the two states where a carrier-facing dispute is
 *                            active (variance_status enum, migration 0002)
 *   recoveredLast30Days  -- sum(recovery_event.amount_recovered) recorded in
 *                            the trailing 30 days (hardcoded window, no
 *                            time-range picker for v1 per the item's No-gos)
 */
export interface FindingsSummary {
  recoverableOpen: string;
  flaggedToday: number;
  withCarriers: number;
  recoveredLast30Days: string;
}

export async function getFindingsSummary(client: pg.PoolClient): Promise<FindingsSummary> {
  const result = await client.query<{
    recoverable_open: string;
    flagged_today: string;
    with_carriers: string;
    recovered_last_30_days: string;
  }>(
    `SELECT
       COALESCE(
         (SELECT SUM(variance_amount) FROM variance_finding WHERE status = 'open'),
         0
       ) AS recoverable_open,
       (
         SELECT COUNT(*) FROM variance_finding
         WHERE created_at >= date_trunc('day', now())
       ) AS flagged_today,
       (
         SELECT COUNT(*) FROM variance_finding
         WHERE status IN ('queued_for_dispute', 'disputed')
       ) AS with_carriers,
       COALESCE(
         (
           SELECT SUM(amount_recovered) FROM recovery_event
           WHERE recorded_at >= now() - interval '30 days'
         ),
         0
       ) AS recovered_last_30_days`,
    [],
  );

  const row = result.rows[0];
  return {
    recoverableOpen: row?.recoverable_open ?? '0',
    flaggedToday: Number(row?.flagged_today ?? 0),
    withCarriers: Number(row?.with_carriers ?? 0),
    recoveredLast30Days: row?.recovered_last_30_days ?? '0',
  };
}
