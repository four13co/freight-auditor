import type pg from 'pg';

/**
 * 86e367r7f: the shared shape behind 6 files' 8 hand-written
 * "INSERT ... ON CONFLICT DO NOTHING RETURNING id, then (if no row) SELECT
 * id FROM <table> WHERE <own predicate>" pairs -- each a 2-round-trip dance
 * with its own re-declared "if (!id) throw ..." triplication. One round
 * trip via the same WITH-CTE idiom write-audit-event.ts already established
 * (audit-ledger/write-audit-event.ts) -- generalized here since every site's
 * fallback predicate matches a different subset of columns (that predicate
 * is each call site's own semantic content, not boilerplate, so it stays
 * caller-supplied rather than being parameterized away).
 *
 * insertSql/fallbackSql are raw fragments the caller writes exactly as
 * before (no RETURNING on insertSql -- this wraps it in one); their combined
 * params are `[...insertParams, ...fallbackParams]`, so fallbackSql's own
 * placeholders must be numbered continuing from insertParams.length + 1
 * (e.g. insertParams of length 4 -> fallbackSql's first placeholder is $5).
 *
 * Concurrency note (named, not silently assumed): this CTE reads the
 * fallback table under the same statement-level snapshot as the INSERT,
 * same as write-audit-event.ts's own accepted precedent. A row committed by
 * a different transaction in the narrow window between this statement's
 * snapshot and its own conflict-check could in theory be missed by the
 * fallback SELECT even though the INSERT correctly detected the conflict
 * (Postgres's ON CONFLICT check always sees the latest committed row,
 * independent of the query's MVCC snapshot) -- yielding a spurious "not
 * found" where the old two-statement form's separately-snapshotted SELECT
 * would have caught it. This window already exists in production via
 * write-audit-event.ts; none of the 6 migrated sites here changes that
 * exposure, it only extends the same accepted tradeoff to more call sites.
 */
export async function insertIdempotent(
  client: pg.PoolClient,
  query: { insertSql: string; insertParams: unknown[]; fallbackSql: string; fallbackParams: unknown[] },
): Promise<{ id: string; created: boolean } | null> {
  const result = await client.query<{ id: string; created: boolean }>(
    `WITH inserted AS (
       ${query.insertSql}
       RETURNING id
     )
     SELECT id, true AS created FROM inserted
     UNION ALL
     SELECT id, false AS created FROM (${query.fallbackSql}) AS existing
     WHERE NOT EXISTS (SELECT 1 FROM inserted)`,
    [...query.insertParams, ...query.fallbackParams],
  );
  return result.rows[0] ?? null;
}
