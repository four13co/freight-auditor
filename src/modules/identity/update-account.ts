import type pg from 'pg';

export interface UpdateAccountInput {
  name?: string;
  isActive?: boolean;
}

export interface UpdatedAccount {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
}

/**
 * 86e38rdnm: PATCH the tenant's own mutable fields. `slug` is deliberately
 * not accepted here -- the task's own Info-tab spec says "slug (read-only
 * after creation)". Builds the SET clause from whichever fields were
 * actually provided so a caller sending only `isActive` doesn't clobber
 * `name` with itself unnecessarily -- but since either alone is a no-op
 * concern only for audit-diffing, not correctness, and this table has no
 * audit trail requirement in this item's ACs, simplicity wins: only the
 * provided fields are written.
 */
export async function updateClient(
  client: pg.PoolClient,
  clientId: string,
  input: UpdateAccountInput,
): Promise<UpdatedAccount | null> {
  const sets: string[] = [];
  const params: unknown[] = [clientId];

  if (input.name !== undefined) {
    params.push(input.name);
    sets.push(`name = $${params.length}`);
  }
  if (input.isActive !== undefined) {
    params.push(input.isActive);
    sets.push(`is_active = $${params.length}`);
  }

  if (sets.length === 0) {
    const { rows } = await client.query<{ id: string; name: string; slug: string; is_active: boolean }>(
      `SELECT id, name, slug, is_active FROM account WHERE id = $1`,
      [clientId],
    );
    const row = rows[0];
    return row ? { id: row.id, name: row.name, slug: row.slug, isActive: row.is_active } : null;
  }

  const { rows } = await client.query<{ id: string; name: string; slug: string; is_active: boolean }>(
    `UPDATE account SET ${sets.join(', ')} WHERE id = $1 RETURNING id, name, slug, is_active`,
    params,
  );
  const row = rows[0];
  return row ? { id: row.id, name: row.name, slug: row.slug, isActive: row.is_active } : null;
}
