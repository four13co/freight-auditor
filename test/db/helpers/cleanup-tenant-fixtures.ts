import type pg from 'pg';

/**
 * Deletes every row belonging to the given client ids, in an order derived
 * from the live foreign-key graph so a child table is always cleared before
 * any table it references -- eliminating the recurring 23503 FK-violation
 * teardown bug (test-teardown-missing-fk-parent-delete, seen across PRs
 * #163, #165, #167) at its root instead of relying on every new
 * `test/db/**` file's `afterAll` to hand-order its own DELETEs correctly.
 *
 * Scope is computed, not hand-maintained: every table with a `client_id`
 * column, plus `client` itself (the implicit root every such column
 * references). A schema change that adds or removes a tenant-scoped table
 * or FK is picked up automatically on the next run -- no second place to
 * remember to update.
 *
 * Must run on a connection that bypasses RLS (the existing `pool.connect()`
 * owner pattern every `test/db/**` file already uses), since this deletes
 * across the full tenant scope rather than one request's visible slice.
 */
export async function cleanupTenantFixtures(pool: pg.Pool, clientIds: string[]): Promise<void> {
  if (clientIds.length === 0) return;

  const client = await pool.connect();
  try {
    const order = await computeTenantDeletionOrder(client);
    for (const table of order) {
      if (table === 'client') {
        await client.query(`DELETE FROM client WHERE id = ANY($1::uuid[])`, [clientIds]);
      } else {
        await client.query(`DELETE FROM "${table}" WHERE client_id = ANY($1::uuid[])`, [clientIds]);
      }
    }
  } finally {
    client.release();
  }
}

/**
 * Topologically sorts { every table with a client_id column } ∪ { client }
 * by their foreign-key edges (child -> parent) so children precede the
 * parents they reference. Kahn's algorithm: a table with no remaining
 * incoming edge (nothing left in scope still references it) is safe to
 * delete now.
 *
 * Queried fresh each call rather than cached -- this only runs in test
 * teardown, never a hot path, and staying live against the schema is the
 * entire point (a hardcoded order is exactly the maintenance burden this
 * replaces).
 */
async function computeTenantDeletionOrder(client: pg.PoolClient): Promise<string[]> {
  const { rows: scopeRows } = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'client_id'`,
  );
  const scope = new Set(scopeRows.map((r) => r.table_name));
  scope.add('client');

  const { rows: edgeRows } = await client.query<{ child_table: string; parent_table: string }>(
    `SELECT DISTINCT
       con.conrelid::regclass::text  AS child_table,
       con.confrelid::regclass::text AS parent_table
     FROM pg_constraint con
     WHERE con.contype = 'f' AND con.connamespace = 'public'::regnamespace`,
  );

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const table of scope) inDegree.set(table, 0);

  for (const { child_table, parent_table } of edgeRows) {
    if (!scope.has(child_table) || !scope.has(parent_table) || child_table === parent_table) continue;
    // child_table must be deleted before parent_table: edge child -> parent,
    // so parent_table's in-degree tracks "how many not-yet-deleted children
    // still reference it."
    dependents.set(child_table, [...(dependents.get(child_table) ?? []), parent_table]);
    inDegree.set(parent_table, (inDegree.get(parent_table) ?? 0) + 1);
  }

  const queue = [...scope].filter((t) => inDegree.get(t) === 0).sort();
  const order: string[] = [];
  while (queue.length > 0) {
    const table = queue.shift()!;
    order.push(table);
    for (const dependent of dependents.get(table) ?? []) {
      const remaining = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, remaining);
      if (remaining === 0) queue.push(dependent);
    }
    queue.sort();
  }

  if (order.length !== scope.size) {
    const stuck = [...scope].filter((t) => !order.includes(t));
    throw new Error(`cleanupTenantFixtures: foreign-key cycle detected among tenant-scoped tables: ${stuck.join(', ')}`);
  }

  return order;
}
