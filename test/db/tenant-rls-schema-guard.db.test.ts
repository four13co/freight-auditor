import { describe, it, expect } from 'vitest';
import { makePool, withOwnerTx } from './helpers.js';

/**
 * P6.A.6 (86e2zfjrj): generalized schema-lint guard, complementing the
 * per-table RLS proofs already in rule-backtest-rls.db.test.ts and
 * contract-rate-rls.db.test.ts. Those prove specific tables behave
 * correctly under a real app-role transaction; this proves NO table with a
 * tenant column is missing the DB-enforced policy in the first place, so a
 * future migration that adds such a table without wiring RLS fails this
 * test immediately rather than silently shipping an unenforced tenant
 * boundary.
 *
 * Enumerates via information_schema.columns rather than hardcoding a table
 * list, so the guard covers a table this test's author never anticipated.
 * Matches `client_id` and `tenant_id` per the task's own framing, plus
 * `scope_client_id` -- `rubric` (0006) is a real tenant table using that
 * name for its tenant column (0009's `apply_tenant_rls` pairs list carries
 * it explicitly), and a guard that can't see it isn't a regression net for
 * that table at all.
 *
 * This run found a live gap: rate_cell (0026_finding_citations) has always
 * carried a mandatory client_id column and a freight_app grant, but 0026
 * never called apply_tenant_rls, unlike every sibling table added since
 * 0009. Fixed in 0076_rate_cell_rls.sql (zero-risk: no source module or
 * test ever inserts into rate_cell). This test would fail against
 * pre-0076 schema state.
 */
describe('tenant RLS schema guard (DB)', () => {
  it('every table with a client_id/tenant_id/scope_client_id column has FORCE RLS and a tenant_isolation policy', async () => {
    const pool = makePool();
    try {
      const tables = await withOwnerTx(pool, async (client) => {
        const { rows } = await client.query<{ table_name: string; column_name: string }>(
          `SELECT c.table_name, c.column_name
             FROM information_schema.columns c
             JOIN pg_class cl
               ON cl.relname = c.table_name
              AND cl.relnamespace = 'public'::regnamespace
              AND cl.relkind = 'r'
            WHERE c.table_schema = 'public'
              AND c.column_name IN ('client_id', 'tenant_id', 'scope_client_id')
            ORDER BY c.table_name`,
        );
        return rows;
      });

      // Regression guard on the enumeration itself: if this ever comes back
      // empty, the query broke (wrong schema, RLS extension not migrated
      // in), not "there happen to be no tenant tables" -- silently passing
      // an empty table list would be worse than useless.
      expect(tables.length).toBeGreaterThan(50);

      const violations: string[] = [];
      await withOwnerTx(pool, async (client) => {
        for (const { table_name, column_name } of tables) {
          const rel = (await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
            `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1 AND relnamespace = 'public'::regnamespace`,
            [table_name],
          )).rows[0];
          const pol = await client.query(
            `SELECT 1 FROM pg_policy WHERE polrelid = $1::regclass AND polname = 'tenant_isolation'`,
            [table_name],
          );
          if (!rel?.relrowsecurity || !rel?.relforcerowsecurity || pol.rowCount !== 1) {
            violations.push(`${table_name} (tenant column: ${column_name}) -- relrowsecurity=${rel?.relrowsecurity}, relforcerowsecurity=${rel?.relforcerowsecurity}, tenant_isolation policy count=${pol.rowCount}`);
          }
        }
      });

      expect(violations, `tables missing FORCE RLS or the tenant_isolation policy:\n${violations.join('\n')}`).toEqual([]);
    } finally {
      await pool.end();
    }
  });
});
