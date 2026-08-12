import type pg from 'pg';
import { getPool, APP_ROLE } from './pool.js';

/**
 * The tenant scope for a unit of work.
 *
 *   clientIds  — the client uuids this request may see. Empty + non-internal
 *                means "no tenant rows visible" (only shared catalog rows).
 *   internal   — an internal analyst: RLS grants cross-client (portfolio) read.
 *
 * These map 1:1 onto the transaction-scoped GUCs the RLS policies read
 * (`app.current_client_ids`, `app.is_internal` — see migrations 0001/0009).
 */
export interface TenantContext {
  clientIds?: string[];
  internal?: boolean;
}

/**
 * Set the transaction-local tenant GUCs, then drop into the RLS-bound app role.
 *
 * This is the runtime crux of Phase 0 (Master Spec §11, §1.7). Tenant isolation
 * is STRUCTURAL — enforced by Postgres RLS, never by app-level `WHERE client_id`.
 * For the policies to bind, three things must all hold *inside one transaction*:
 *
 *   1. `set_config('app.current_client_ids', …, true)` — the request's client
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
    'app.current_client_ids',
    (ctx.clientIds ?? []).join(','),
  ]);
  await client.query('SELECT set_config($1, $2, true)', [
    'app.is_internal',
    ctx.internal ? 'true' : 'false',
  ]);
  await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
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
  const client = await getPool().connect();
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
