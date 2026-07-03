import pg from 'pg';

/**
 * DB test helpers. These run against the ephemeral local Postgres pointed to by
 * DATABASE_URL (spun up per-run; never a protected host). The connecting user
 * is a superuser (the container's `fa`), so to exercise RLS and the append-only
 * grants we `SET ROLE freight_app` — dropping the superuser exemption — inside
 * a transaction that also sets the tenant GUCs the RLS policies read.
 */

const { Pool } = pg;

export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  // Safety: refuse to run against anything but a local/ephemeral host.
  if (!/@(127\.0\.0\.1|localhost|::1)[:/]/.test(url)) {
    throw new Error(`DATABASE_URL must be local/ephemeral for tests, got: ${url}`);
  }
  return url;
}

export function makePool(): pg.Pool {
  return new Pool({ connectionString: requireDatabaseUrl(), max: 4 });
}

/**
 * Run `fn` inside a transaction scoped to the app role and a tenant context.
 * Mirrors how a real request runs: SET LOCAL ROLE + the app.* GUCs, so RLS
 * policies and the freight_app grants both apply. Always rolls back so tests
 * don't leak state.
 */
export async function withAppTx<T>(
  pool: pg.Pool,
  opts: { clientIds?: string[]; internal?: boolean },
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_client_ids', $1, true)", [
      (opts.clientIds ?? []).join(','),
    ]);
    await client.query("SELECT set_config('app.is_internal', $1, true)", [
      opts.internal ? 'true' : 'false',
    ]);
    await client.query('SET LOCAL ROLE freight_app');
    const result = await fn(client);
    await client.query('ROLLBACK');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore rollback error */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Run `fn` as the owning superuser (setup/seed that must bypass RLS). Rolls back. */
export async function withOwnerTx<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('ROLLBACK');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}
