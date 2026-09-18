import type pg from 'pg';

/**
 * 86e38rdnm: tenant-admin member removal. `found: false` covers both
 * "doesn't exist" and "belongs to a different tenant" -- the WHERE clause
 * on account_id is the real boundary here (RLS also protects it under a
 * non-internal scope, but this route always runs `internal: true`), same
 * "silently zero, never a distinguishing error" convention as
 * update-portal-member-role.ts.
 */
export async function removeMembership(
  client: pg.PoolClient,
  clientId: string,
  membershipId: string,
): Promise<{ found: boolean }> {
  const { rowCount } = await client.query(
    `DELETE FROM membership WHERE id = $1 AND account_id = $2`,
    [membershipId, clientId],
  );
  return { found: (rowCount ?? 0) > 0 };
}
