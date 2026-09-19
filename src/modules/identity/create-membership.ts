import type pg from 'pg';
import { insertIdempotent } from '../../db/insert-idempotent.js';

export interface CreateMembershipInput {
  clientId: string;
  email: string;
  fullName?: string | null;
  role: string;
  /**
   * 86e3a76bz: the new Client-/Vendor-level scope columns (migration 0084),
   * nullable per the ancestor-chain convention -- a Vendor-scoped membership
   * sets both; a Client-scoped membership sets only scopeClientId; an
   * Account-scoped membership (the pre-existing behavior) sets neither.
   * Named `scope*` rather than reusing `clientId` (which, despite the name,
   * has always meant the ACCOUNT id here -- a naming leftover from before
   * migration 0083's rename) to avoid exactly the collision that field name
   * would otherwise create against the NEW middle-tier Client entity.
   */
  scopeClientId?: string;
  scopeVendorId?: string;
}

export type CreateMembershipResult =
  | { created: true; membershipId: string; userId: string; isNewUser: boolean }
  | { created: false; reason: 'already_member' };

/**
 * 86e38rdnm: tenant-admin member assignment. Finds the app_user by email
 * (case-sensitive -- app_user.email has no citext/lower() index in this
 * schema, matching every other email lookup in this codebase), creating one
 * if none exists, then inserts the membership row.
 *
 * membership carries a UNIQUE index on (user_id, COALESCE(vendor_id,
 * client_id, account_id)) (migration 0084, replacing migration 0003's
 * plain UNIQUE (user_id, account_id) -- see 0084's own header comment for
 * why: decision 2 lets one user hold an Account-level membership AND a
 * separate Client-level membership within the same account, which the old
 * constraint would have rejected as a duplicate since both rows carry the
 * same account_id ancestor). A repeat call for the same user+scope hits that
 * index, mapped here to `created: false` (the route surfaces 409) rather
 * than letting the unique-violation propagate as a 500.
 *
 * Runs inside the caller's withTenantTx ({ internal: true }) -- membership
 * carries FORCE RLS keyed on account_id (migration 0009), so the INSERT's
 * WITH CHECK needs app_is_internal() to admit a account_id the caller has no
 * membership row for yet, same reasoning as create-customer-branding.ts.
 */
export async function createMembership(
  client: pg.PoolClient,
  input: CreateMembershipInput,
): Promise<CreateMembershipResult> {
  const existingUser = await client.query<{ id: string }>(`SELECT id FROM app_user WHERE email = $1`, [input.email]);

  let userId: string;
  let isNewUser: boolean;
  if (existingUser.rows[0]) {
    userId = existingUser.rows[0].id;
    isNewUser = false;
  } else {
    const created = await client.query<{ id: string }>(
      `INSERT INTO app_user (email, full_name) VALUES ($1, $2) RETURNING id`,
      [input.email, input.fullName ?? null],
    );
    userId = created.rows[0]!.id;
    isNewUser = true;
  }

  const scopeClientId = input.scopeClientId ?? null;
  const scopeVendorId = input.scopeVendorId ?? null;

  const membership = await insertIdempotent(client, {
    insertSql: `INSERT INTO membership (user_id, account_id, client_id, vendor_id, role) VALUES ($1, $2, $3::uuid, $4::uuid, $5::membership_role)
      ON CONFLICT DO NOTHING`,
    insertParams: [userId, input.clientId, scopeClientId, scopeVendorId, input.role],
    // Fallback predicate matches the SAME coalesced scope the unique index enforces --
    // not just (user_id, account_id) -- so a repeat call at any of the three levels
    // (Account/Client/Vendor) finds the existing row instead of a false "not found".
    // Explicit ::uuid casts: a bare NULL parameter (Account-scoped call) has no type
    // Postgres can infer on its own, and defaults to text -- which then fails to
    // compare against the uuid columns on the left of COALESCE.
    fallbackSql: `SELECT id FROM membership WHERE user_id = $6 AND COALESCE(vendor_id, client_id, account_id) = COALESCE($9::uuid, $8::uuid, $7::uuid)`,
    fallbackParams: [userId, input.clientId, scopeClientId, scopeVendorId],
  });

  if (!membership || !membership.created) return { created: false, reason: 'already_member' };
  return { created: true, membershipId: membership.id, userId, isNewUser };
}
