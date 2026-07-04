import type pg from 'pg';

/**
 * Minimal contract-rate lookup (Master Spec §6.4 slice, Phase 2 — 86e25te91).
 *
 * The full rate model (rate_rule/rate_table/rate_cell, Match->Compute->
 * Constrain->Cite) is deferred; this is one contracted rate per (contract
 * version, charge category), starting with LINEHAUL. A lookup miss returns
 * `null` — never a guessed/defaulted rate (§10: a missing value reported
 * honestly is correct; a guessed value is a defect). The caller (the
 * evaluator's fact-bundle resolution) turns a miss into UNASSESSABLE, never
 * a fabricated CONFORMED/VARIANCE verdict.
 */
export interface ContractRate {
  amount: string; // decimal string, 4dp canonical
  currency: string;
  clauseId: string | null;
}

export async function lookupContractRate(
  client: pg.PoolClient,
  contractVersionId: string,
  category: string,
): Promise<ContractRate | null> {
  const res = await client.query<{ rate: string; currency: string; clause_id: string | null }>(
    `SELECT rate, currency, clause_id FROM contract_rate
     WHERE contract_version_id = $1 AND category = $2`,
    [contractVersionId, category],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { amount: row.rate, currency: row.currency, clauseId: row.clause_id };
}
