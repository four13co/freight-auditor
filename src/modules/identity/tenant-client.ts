import type pg from 'pg';

/**
 * 86e3a76bz: CRUD for the `client` table -- the middle tenant-hierarchy tier
 * (Account -> Client -> Vendor; "Grand Client" is retired terminology, never
 * used here). Mirrors list-accounts.ts/update-account.ts's own shape one
 * level down. Named tenant-client.ts (not client.ts) to keep this file's
 * identity distinct at a glance from the pre-existing account-level
 * onboarding.ts/list-accounts.ts/update-account.ts trio, which still use
 * "client" in their own function names (createClient, listClients,
 * updateClient) as a naming leftover from before migration 0083's rename --
 * tenant-admin-routes.ts already aliases one of those imports
 * (`createClient as createClientRow`) to avoid exactly this collision.
 *
 * Every query here runs inside the caller's withTenantTx ({ internal: true
 * }, tenant-admin-routes.ts's own gating) -- `client` carries FORCE RLS
 * (migration 0084), so app_is_internal() is what admits rows regardless of
 * account_id for this internal-admin surface, same as every sibling module
 * in this directory. The `account_id = $N` clause in every statement below
 * is still the real tenant boundary for this internal caller (RLS gives it
 * none), matching remove-membership.ts's documented convention.
 */

export interface TenantClientRow {
  id: string;
  accountId: string;
  name: string;
  isActive: boolean;
  createdAt: Date;
}

function toRow(r: { id: string; account_id: string; name: string; is_active: boolean; created_at: Date }): TenantClientRow {
  return { id: r.id, accountId: r.account_id, name: r.name, isActive: r.is_active, createdAt: r.created_at };
}

/**
 * 86e3a76bz Review fix: verifies `clientId` actually belongs to `accountId`
 * before a caller is allowed to create a Vendor under it or assign a
 * Client-/Vendor-scoped membership against it -- see
 * tenant-vendor.ts's createTenantVendor for the full rationale (same check,
 * same gap: two independent URL path params with nothing else tying them
 * together).
 */
export async function clientBelongsToAccount(client: pg.PoolClient, accountId: string, clientId: string): Promise<boolean> {
  const { rowCount } = await client.query(`SELECT 1 FROM client WHERE id = $1 AND account_id = $2`, [clientId, accountId]);
  return (rowCount ?? 0) > 0;
}

export async function createTenantClient(
  client: pg.PoolClient,
  input: { accountId: string; name: string },
): Promise<{ id: string }> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO client (account_id, name) VALUES ($1, $2) RETURNING id`,
    [input.accountId, input.name],
  );
  return { id: rows[0]!.id };
}

export async function listTenantClients(client: pg.PoolClient, accountId: string): Promise<TenantClientRow[]> {
  const { rows } = await client.query<{ id: string; account_id: string; name: string; is_active: boolean; created_at: Date }>(
    `SELECT id, account_id, name, is_active, created_at FROM client WHERE account_id = $1 ORDER BY created_at DESC, id ASC`,
    [accountId],
  );
  return rows.map(toRow);
}

export interface UpdateTenantClientInput {
  name?: string;
  isActive?: boolean;
}

export async function updateTenantClient(
  client: pg.PoolClient,
  accountId: string,
  clientId: string,
  input: UpdateTenantClientInput,
): Promise<TenantClientRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [clientId, accountId];

  if (input.name !== undefined) {
    params.push(input.name);
    sets.push(`name = $${params.length}`);
  }
  if (input.isActive !== undefined) {
    params.push(input.isActive);
    sets.push(`is_active = $${params.length}`);
  }

  const query = sets.length === 0
    ? { sql: `SELECT id, account_id, name, is_active, created_at FROM client WHERE id = $1 AND account_id = $2`, params }
    : { sql: `UPDATE client SET ${sets.join(', ')} WHERE id = $1 AND account_id = $2 RETURNING id, account_id, name, is_active, created_at`, params };

  const { rows } = await client.query<{ id: string; account_id: string; name: string; is_active: boolean; created_at: Date }>(query.sql, query.params);
  const row = rows[0];
  return row ? toRow(row) : null;
}
