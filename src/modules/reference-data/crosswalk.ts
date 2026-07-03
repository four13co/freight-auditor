import type pg from 'pg';

/**
 * Charge-code crosswalk resolution (Master Spec §6.2).
 *
 * Maps a carrier's raw charge code to a canonical category. Most-specific rule
 * wins, per the documented precedence:
 *
 *   client+carrier+code (4) > carrier+code (3) > carrier+pattern (2) > global (1)
 *
 * The precedence is materialised on the row as `precedence_rank`, so resolution
 * is a single ORDER BY: match any applicable rule, take the highest rank. Rows
 * with client_id IS NULL are the shared global catalog (readable across tenants
 * via RLS, §6.10); a client-specific row outranks them.
 *
 * Must run inside a tenant transaction (withTenantTx): the query relies on RLS
 * to expose the caller's client rows + global rows, and to hide other tenants'.
 */
export interface CrosswalkQuery {
  carrierId: string;
  sourceCode: string;
}

export interface CrosswalkMatch {
  canonicalCategory: string;
  precedenceRank: number;
}

export async function resolveChargeCode(
  client: pg.PoolClient,
  q: CrosswalkQuery,
): Promise<CrosswalkMatch | null> {
  // Applicable rows:
  //   - exact code match for this carrier (ranks 3/4), OR
  //   - a pattern match for this carrier (rank 2), OR
  //   - a carrier-agnostic global rule (carrier_id IS NULL).
  // RLS already restricts client_id to {caller's clients} ∪ {NULL global}, so
  // we never leak another tenant's client-specific override.
  const { rows } = await client.query<{
    canonical_category: string;
    precedence_rank: number;
  }>(
    `SELECT canonical_category, precedence_rank
       FROM charge_code_crosswalk
      WHERE (carrier_id = $1 OR carrier_id IS NULL)
        AND (
              source_code = $2
           OR (source_pattern IS NOT NULL AND $2 ~ source_pattern)
        )
      ORDER BY precedence_rank DESC, created_at DESC
      LIMIT 1`,
    [q.carrierId, q.sourceCode],
  );
  const row = rows[0];
  return row
    ? { canonicalCategory: row.canonical_category, precedenceRank: row.precedence_rank }
    : null;
}
