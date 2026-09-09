import type pg from 'pg';

export type SeedDedicatedTenantMembershipRole = 'analyst' | 'lead' | 'client_admin' | 'client_viewer';

export interface SeedDedicatedTenantOptions {
  /** Exact `client.name` value -- some specs assert on it directly, so this is never mangled or suffixed. */
  clientName: string;
  /** If given, also seeds an app_user + a membership(role) row on the new client. */
  role?: SeedDedicatedTenantMembershipRole;
  /** `app_user.full_name`. Required when `role` is given (ignored otherwise). */
  userName?: string;
  /** If given, also seeds a carrier row with this exact name. */
  carrierName?: string;
}

export interface SeedDedicatedTenantResult {
  clientId: string;
  userId?: string;
  carrierId?: string;
}

/**
 * 86e367r99: the "INSERT INTO client -> INSERT INTO app_user -> INSERT INTO
 * membership -> INSERT INTO carrier" fixture-bootstrap sequence duplicated
 * across 6 fullstack e2e specs. Each optional piece (user+membership,
 * carrier) is independently toggled since not every spec needs all of
 * them -- branding.fullstack.spec.ts seeds bare clients only (two calls, no
 * role/carrier); contract-ingestion-lifecycle.fullstack.spec.ts resolves its
 * carrier via the shared dev fixture instead of seeding its own. A
 * multi-tenant spec (portfolio-recovery-report, single-tenant-recovery-report)
 * calls this once per client.
 *
 * portfolio-recovery-report's free-standing internal analyst (is_internal
 * true, no client, no membership at all) is NOT a tenant fixture in the
 * sense this helper covers -- it stays its own explicit 2-line insert in
 * that spec, since forcing a clientId-less user through a function named
 * "seed a dedicated TENANT" would be the wrong abstraction.
 */
export async function seedDedicatedTenant(
  pool: pg.Pool,
  options: SeedDedicatedTenantOptions,
): Promise<SeedDedicatedTenantResult> {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const clientRow = await pool.query<{ id: string }>(
    `INSERT INTO client (name, slug) VALUES ($1, $2) RETURNING id`,
    [options.clientName, `e2e-${tag}`],
  );
  const clientId = clientRow.rows[0]!.id;

  let userId: string | undefined;
  if (options.role) {
    const userRow = await pool.query<{ id: string }>(
      `INSERT INTO app_user (email, full_name) VALUES ($1, $2) RETURNING id`,
      [`e2e-${tag}@example.test`, options.userName],
    );
    userId = userRow.rows[0]!.id;
    await pool.query(
      `INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, $3)`,
      [userId, clientId, options.role],
    );
  }

  let carrierId: string | undefined;
  if (options.carrierName) {
    const carrierRow = await pool.query<{ id: string }>(
      `INSERT INTO carrier (name) VALUES ($1) RETURNING id`,
      [options.carrierName],
    );
    carrierId = carrierRow.rows[0]!.id;
  }

  return { clientId, userId, carrierId };
}
