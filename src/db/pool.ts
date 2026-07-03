import pg from 'pg';

/**
 * Process-wide connection pool.
 *
 * The pool connects using DATABASE_URL. In production that URL authenticates as
 * a role that is NOT a superuser and does NOT hold BYPASSRLS, so Row-Level
 * Security (migration 0009) and the append-only grants (migration 0010) bind.
 * On a single-DB dev/test box the login role may be the owner; every tenant
 * transaction additionally `SET LOCAL ROLE freight_app` (see withTenantTx), which
 * drops the owner's implicit RLS exemption for the life of that transaction — so
 * isolation is enforced regardless of which role the pool logs in as.
 */
const { Pool } = pg;

let pool: pg.Pool | undefined;

/** The dedicated application role. The runtime assumes this identity per request. */
export const APP_ROLE = 'freight_app';

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return url;
}

/** Lazily construct (and memoise) the shared pool. */
export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({ connectionString: requireDatabaseUrl(), max: 10 });
  }
  return pool;
}

/** Close the shared pool (server shutdown / test teardown). Idempotent. */
export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = undefined;
    await p.end();
  }
}

export type { Pool, PoolClient } from 'pg';
