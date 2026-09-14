import type pg from 'pg';

export interface UpdateUserProfileInput {
  name?: string;
  image?: string | null;
}

export interface UpdatedUserProfile {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
}

/**
 * 86e38pz8e: PATCH /api/profile's backing write. app_user carries no RLS
 * (absent from migration 0009's apply_tenant_rls list -- it's a global
 * identity table, not tenant-scoped), so the WHERE id = $1 clause here IS
 * the entire security boundary: userId always comes from
 * request.actorUserId (the session-verified caller), never from the
 * request body, so this can only ever update the caller's own row.
 *
 * Only `name`/`image` are settable -- role, tenant membership, email, and
 * is_internal all live outside this function's input type entirely (the
 * route layer rejects a body that even mentions one of those, before this
 * is ever called).
 */
export async function updateUserProfile(
  client: pg.PoolClient,
  userId: string,
  input: UpdateUserProfileInput,
): Promise<UpdatedUserProfile | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 2;

  if (input.name !== undefined) {
    sets.push(`name = $${paramIndex++}`);
    values.push(input.name);
  }
  if (input.image !== undefined) {
    sets.push(`image = $${paramIndex++}`);
    values.push(input.image);
  }
  // The route layer (profile-routes.ts) rejects a request with neither
  // field before this is ever called -- there is no "nothing to set"
  // caller to support here.
  sets.push(`updated_at = now()`);
  const result = await client.query<{ id: string; name: string | null; email: string; image: string | null }>(
    `UPDATE app_user SET ${sets.join(', ')} WHERE id = $1 RETURNING id, name, email, image`,
    [userId, ...values],
  );
  return result.rows[0] ?? null;
}
