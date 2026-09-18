import type pg from 'pg';

export interface ContractVersionOption {
  contractVersionId: string;
  contractId: string;
  contractName: string;
  versionLabel: string | null;
  validFrom: string;
  validTo: string | null;
}

/**
 * 86e3a6rg1: the Rates tab's "which contract version does this rate belong
 * to" picker. contract_rate is keyed on contract_version_id, not contract_id
 * directly (0011), so the create-rate form needs the version-level list, not
 * just contract names.
 */
export async function listContractVersionsForTenant(client: pg.PoolClient, clientId: string): Promise<ContractVersionOption[]> {
  const { rows } = await client.query<{
    contract_version_id: string; contract_id: string; contract_name: string;
    version_label: string | null; valid_from: string; valid_to: string | null;
  }>(
    `SELECT cv.id AS contract_version_id, c.id AS contract_id, c.name AS contract_name,
            cv.version_label, cv.valid_from, cv.valid_to
       FROM contract_version cv
       JOIN contract c ON c.id = cv.contract_id
      WHERE cv.account_id = $1
      ORDER BY c.name ASC, cv.valid_from DESC`,
    [clientId],
  );
  return rows.map((r) => ({
    contractVersionId: r.contract_version_id,
    contractId: r.contract_id,
    contractName: r.contract_name,
    versionLabel: r.version_label,
    validFrom: r.valid_from,
    validTo: r.valid_to,
  }));
}
