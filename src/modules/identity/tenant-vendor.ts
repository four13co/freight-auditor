import type pg from 'pg';
import { clientBelongsToAccount } from './tenant-client.js';

/**
 * 86e3a76bz: CRUD for the `vendor` table -- the bottom tenant-hierarchy tier
 * (Account -> Client -> Vendor). Same conventions as tenant-client.ts one
 * level down: internal-admin-only, FORCE RLS admits via app_is_internal(),
 * and every statement's account_id/client_id equality is the real boundary
 * for this caller.
 */

export interface TenantVendorRow {
  id: string;
  accountId: string;
  clientId: string;
  name: string;
  contactInfo: string | null;
  isActive: boolean;
  createdAt: Date;
}

function toRow(r: {
  id: string; account_id: string; client_id: string; name: string;
  contact_info: string | null; is_active: boolean; created_at: Date;
}): TenantVendorRow {
  return {
    id: r.id, accountId: r.account_id, clientId: r.client_id, name: r.name,
    contactInfo: r.contact_info, isActive: r.is_active, createdAt: r.created_at,
  };
}

/**
 * 86e3a76bz Review fix: `accountId` and `clientId` arrive as two independent
 * URL path params with nothing tying them together -- RLS's WITH CHECK on
 * `vendor` only tests each column against the caller's own scope GUCs, it
 * has no way to enforce that `clientId`'s actual account matches the
 * `accountId` column on the same row (no composite FK ties them). Without
 * this check, a mismatched pair (stale UI cache, copy-paste error, a future
 * less-trusted internal role) would silently insert a vendor row whose
 * ancestor-chain columns are inconsistent -- undermining the invariant
 * decision 4's RLS design depends on, with no error. Mirrors
 * contract-rate-admin.ts's createContractRate ownership-check pattern.
 */
export class TenantVendorParentNotFoundError extends Error { readonly code = 'CLIENT_NOT_FOUND'; }

export async function createTenantVendor(
  client: pg.PoolClient,
  input: { accountId: string; clientId: string; name: string; contactInfo?: string | null },
): Promise<{ id: string }> {
  if (!(await clientBelongsToAccount(client, input.accountId, input.clientId))) {
    throw new TenantVendorParentNotFoundError('client not found for this tenant');
  }

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO vendor (account_id, client_id, name, contact_info) VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.accountId, input.clientId, input.name, input.contactInfo ?? null],
  );
  return { id: rows[0]!.id };
}

/**
 * 86e3a76bz Review fix: the same ownership gap, reused by the vendor-scoped
 * membership-assignment route to verify `vendorId` actually belongs to
 * `clientId` before calling createMembership -- see createTenantVendor's own
 * comment for why this matters even though the route is internal-gated.
 */
export async function vendorBelongsToClient(client: pg.PoolClient, clientId: string, vendorId: string): Promise<boolean> {
  const { rowCount } = await client.query(`SELECT 1 FROM vendor WHERE id = $1 AND client_id = $2`, [vendorId, clientId]);
  return (rowCount ?? 0) > 0;
}

/** `accountId` is the outer boundary check (defense-in-depth, RLS aside) confirming `clientId` actually belongs to this account. */
export async function listTenantVendors(client: pg.PoolClient, accountId: string, clientId: string): Promise<TenantVendorRow[]> {
  const { rows } = await client.query<{
    id: string; account_id: string; client_id: string; name: string; contact_info: string | null; is_active: boolean; created_at: Date;
  }>(
    `SELECT id, account_id, client_id, name, contact_info, is_active, created_at
       FROM vendor WHERE account_id = $1 AND client_id = $2 ORDER BY created_at DESC, id ASC`,
    [accountId, clientId],
  );
  return rows.map(toRow);
}

export interface UpdateTenantVendorInput {
  name?: string;
  contactInfo?: string | null;
  isActive?: boolean;
}

export async function updateTenantVendor(
  client: pg.PoolClient,
  accountId: string,
  clientId: string,
  vendorId: string,
  input: UpdateTenantVendorInput,
): Promise<TenantVendorRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [vendorId, accountId, clientId];

  if (input.name !== undefined) {
    params.push(input.name);
    sets.push(`name = $${params.length}`);
  }
  if (input.contactInfo !== undefined) {
    params.push(input.contactInfo);
    sets.push(`contact_info = $${params.length}`);
  }
  if (input.isActive !== undefined) {
    params.push(input.isActive);
    sets.push(`is_active = $${params.length}`);
  }

  const selectSql = `SELECT id, account_id, client_id, name, contact_info, is_active, created_at FROM vendor WHERE id = $1 AND account_id = $2 AND client_id = $3`;
  const query = sets.length === 0
    ? { sql: selectSql, params }
    : { sql: `UPDATE vendor SET ${sets.join(', ')} WHERE id = $1 AND account_id = $2 AND client_id = $3 RETURNING id, account_id, client_id, name, contact_info, is_active, created_at`, params };

  const { rows } = await client.query<{
    id: string; account_id: string; client_id: string; name: string; contact_info: string | null; is_active: boolean; created_at: Date;
  }>(query.sql, query.params);
  const row = rows[0];
  return row ? toRow(row) : null;
}
