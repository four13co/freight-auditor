import type pg from 'pg';
import { insertIdempotent } from '../../db/insert-idempotent.js';

export interface CreateMembershipInput {
  clientId: string;
  email: string;
  fullName?: string | null;
  role: string;
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
 * membership carries UNIQUE (user_id, account_id) (migration 0003) -- a
 * repeat call for the same user+tenant hits that constraint, mapped here to
 * `created: false` (the route surfaces 409) rather than letting the
 * unique-violation propagate as a 500.
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

  const membership = await insertIdempotent(client, {
    insertSql: `INSERT INTO membership (user_id, account_id, role) VALUES ($1, $2, $3::membership_role)
      ON CONFLICT (user_id, account_id) DO NOTHING`,
    insertParams: [userId, input.clientId, input.role],
    fallbackSql: `SELECT id FROM membership WHERE user_id = $4 AND account_id = $5`,
    fallbackParams: [userId, input.clientId],
  });

  if (!membership || !membership.created) return { created: false, reason: 'already_member' };
  return { created: true, membershipId: membership.id, userId, isNewUser };
}
