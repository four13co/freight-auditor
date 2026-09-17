import type pg from 'pg';

export interface ContractRateRow {
  id: string;
  contractVersionId: string;
  contractId: string;
  contractName: string;
  versionLabel: string | null;
  category: string;
  amount: string;
  currency: string;
  clauseId: string | null;
  createdAt: Date;
}

/**
 * 86e3a6rg1 Rates tab: basic CRUD over contract_rate (0011), the one live
 * rate table -- "single flat rate lookup"; rate_rule/rate_table/rate_cell
 * (the full Match->Compute->Constrain->Cite pipeline) stay unwired, per the
 * task's own Context note. Every function takes clientId explicitly and
 * filters on it in SQL (the { internal: true } tenant context these routes
 * run under bypasses RLS entirely, same as list-tenant-members.ts's own
 * pattern) -- scoping is the query's job here, not the database's.
 */
export async function listContractRates(client: pg.PoolClient, clientId: string): Promise<ContractRateRow[]> {
  const { rows } = await client.query<{
    id: string; contract_version_id: string; contract_id: string; contract_name: string;
    version_label: string | null; category: string; rate: string; currency: string;
    clause_id: string | null; created_at: Date;
  }>(
    `SELECT r.id, r.contract_version_id, c.id AS contract_id, c.name AS contract_name,
            cv.version_label, r.category, r.rate, r.currency, r.clause_id, r.created_at
       FROM contract_rate r
       JOIN contract_version cv ON cv.id = r.contract_version_id
       JOIN contract c ON c.id = cv.contract_id
      WHERE r.client_id = $1
      ORDER BY r.created_at DESC, r.id ASC`,
    [clientId],
  );
  return rows.map((r) => ({
    id: r.id,
    contractVersionId: r.contract_version_id,
    contractId: r.contract_id,
    contractName: r.contract_name,
    versionLabel: r.version_label,
    category: r.category,
    amount: r.rate,
    currency: r.currency,
    clauseId: r.clause_id,
    createdAt: r.created_at,
  }));
}

export class ContractRateNotFoundError extends Error { readonly code = 'CONTRACT_VERSION_NOT_FOUND'; }

export async function createContractRate(client: pg.PoolClient, clientId: string, input: {
  contractVersionId: string; category: string; amount: string; currency: string; clauseId?: string | null;
}): Promise<{ id: string }> {
  const owned = await client.query(`SELECT 1 FROM contract_version WHERE id = $1 AND client_id = $2`, [input.contractVersionId, clientId]);
  if (owned.rowCount === 0) throw new ContractRateNotFoundError('contract version not found for this tenant');

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO contract_rate (client_id, contract_version_id, category, rate, currency, clause_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [clientId, input.contractVersionId, input.category, input.amount, input.currency, input.clauseId ?? null],
  );
  return { id: rows[0]!.id };
}

/**
 * Builds the SET clause from whichever fields were actually provided, same
 * convention as update-client.ts -- clauseId is nullable-clearable, so its
 * presence is checked with `in`, not `!== undefined` alone (a caller may
 * legitimately send `clauseId: null` to remove a citation).
 */
export async function updateContractRate(client: pg.PoolClient, clientId: string, rateId: string, patch: {
  category?: string; amount?: string; currency?: string; clauseId?: string | null;
}): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [rateId, clientId];

  if (patch.category !== undefined) {
    params.push(patch.category);
    sets.push(`category = $${params.length}`);
  }
  if (patch.amount !== undefined) {
    params.push(patch.amount);
    sets.push(`rate = $${params.length}`);
  }
  if (patch.currency !== undefined) {
    params.push(patch.currency);
    sets.push(`currency = $${params.length}`);
  }
  if ('clauseId' in patch) {
    params.push(patch.clauseId ?? null);
    sets.push(`clause_id = $${params.length}`);
  }

  if (sets.length === 0) {
    const { rowCount } = await client.query(`SELECT 1 FROM contract_rate WHERE id = $1 AND client_id = $2`, [rateId, clientId]);
    return (rowCount ?? 0) > 0;
  }

  const { rowCount } = await client.query(
    `UPDATE contract_rate SET ${sets.join(', ')} WHERE id = $1 AND client_id = $2`,
    params,
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteContractRate(client: pg.PoolClient, clientId: string, rateId: string): Promise<boolean> {
  const { rowCount } = await client.query(`DELETE FROM contract_rate WHERE id = $1 AND client_id = $2`, [rateId, clientId]);
  return (rowCount ?? 0) > 0;
}
