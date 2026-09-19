import type pg from 'pg';
import { getPool, getReplicaPool, APP_ROLE } from './pool.js';

/**
 * The tenant scope for a unit of work.
 *
 *   clientIds  — the client uuids this request may see. Empty + non-internal
 *                means "no tenant rows visible" (only shared catalog rows).
 *   internal   — an internal analyst: RLS grants cross-client (portfolio) read.
 *   scopedClientIds / scopedVendorIds — 86e3a76bz: the Client- and
 *                Vendor-level scope GUCs `apply_hierarchical_tenant_rls()`
 *                (migration 0084) reads on the `client`/`vendor` tables.
 *                DORMANT as of 0084: nothing populates these from a real
 *                session yet (no portal auth resolver reads a Client- or
 *                Vendor-scoped membership) — they exist so the schema is
 *                ready, and so a test can exercise the RLS branch directly.
 *                Named `scoped*` rather than reusing `clientIds` to avoid
 *                colliding with that field's own (pre-0083-rename-legacy)
 *                name, which actually holds ACCOUNT ids.
 *
 * These map 1:1 onto the transaction-scoped GUCs the RLS policies read
 * (`app.current_account_ids`, `app.is_internal` — see migrations 0001/0009 —
 * plus `app.current_client_ids`/`app.current_vendor_ids`, migration 0084).
 */
export interface TenantContext {
  clientIds?: string[];
  internal?: boolean;
  scopedClientIds?: string[];
  scopedVendorIds?: string[];
}

/**
 * Set the transaction-local tenant GUCs, then drop into the RLS-bound app role.
 *
 * This is the runtime crux of Phase 0 (Master Spec §11, §1.7). Tenant isolation
 * is STRUCTURAL — enforced by Postgres RLS, never by app-level `WHERE account_id`.
 * For the policies to bind, three things must all hold *inside one transaction*:
 *
 *   1. `set_config('app.current_account_ids', …, true)` — the request's client
 *      scope, transaction-local (the `true` third arg = SET LOCAL semantics).
 *   2. `set_config('app.is_internal', …, true)` — the portfolio-access flag.
 *   3. `SET LOCAL ROLE freight_app` — drop any superuser/owner BYPASSRLS
 *      exemption so the USING/WITH CHECK clauses actually apply.
 *
 * GUCs are set first, then role: `set_config` runs as the login role; `SET
 * ROLE` last so the body executes under the (RLS-bound) app role. Must be
 * called after `BEGIN` and before the transaction body — every caller that
 * runs tenant-scoped queries goes through this (directly via `withTenantTx`,
 * or via a test helper that shares this same setup) so a query issued outside
 * such a transaction runs with an empty scope (fails closed: no tenant rows),
 * never open.
 */
export async function setTenantTxScope(client: pg.PoolClient, ctx: TenantContext): Promise<void> {
  await client.query('SELECT set_config($1, $2, true)', [
    'app.current_account_ids',
    (ctx.clientIds ?? []).join(','),
  ]);
  await client.query('SELECT set_config($1, $2, true)', [
    'app.current_scoped_client_ids',
    (ctx.scopedClientIds ?? []).join(','),
  ]);
  await client.query('SELECT set_config($1, $2, true)', [
    'app.current_scoped_vendor_ids',
    (ctx.scopedVendorIds ?? []).join(','),
  ]);
  await client.query('SELECT set_config($1, $2, true)', [
    'app.is_internal',
    ctx.internal ? 'true' : 'false',
  ]);
  await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
}

async function runTenantTx<T>(
  pool: pg.Pool,
  ctx: TenantContext,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setTenantTxScope(client, ctx);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* the original error is what matters; ignore a secondary rollback failure */
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run `fn` inside a single transaction scoped to a tenant context.
 *
 * The transaction commits on success and rolls back on any throw. A dedicated
 * client is checked out for the transaction and always released.
 */
export async function withTenantTx<T>(
  ctx: TenantContext,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return runTenantTx(getPool(), ctx, fn);
}

/**
 * Read-only variant of `withTenantTx` (86e2zfjym): routes through the
 * optional read-replica pool when `DATABASE_READ_REPLICA_URL` is configured,
 * else falls back to the primary pool — identical behavior to `withTenantTx`
 * when unconfigured. Runs the exact same `setTenantTxScope` GUC + `SET LOCAL
 * ROLE` sequence on whichever connection it checks out, so RLS still binds on
 * the replica. Writes must never use this — only `withTenantTx` acquires a
 * connection guaranteed to be the primary.
 */
export async function withTenantReadTx<T>(
  ctx: TenantContext,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return runTenantTx(getReplicaPool() ?? getPool(), ctx, fn);
}
