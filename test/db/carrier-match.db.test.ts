import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { matchCarrierName } from '../../src/modules/ingestion/carrier-match.js';

/**
 * 86e2xb911: fuzzy carrier-name resolution against the real carrier catalog.
 * Proves the item's own Rabbit-hole requirement -- ambiguity surfaces
 * honestly (as candidates) rather than a silent best-guess -- against real
 * rows, not a mocked query.
 */
describe('matchCarrierName (DB)', () => {
  let pool: pg.Pool;
  const tag = `carriermatch-${Date.now()}`;
  let exactCarrierId: string;
  let ambiguousCarrierAId: string;
  let ambiguousCarrierBId: string;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const exact = await owner.query(
        `INSERT INTO carrier (name) VALUES ($1) RETURNING id`,
        [`Acme Freight Co ${tag}`],
      );
      exactCarrierId = exact.rows[0].id;

      const a = await owner.query(
        `INSERT INTO carrier (name) VALUES ($1) RETURNING id`,
        [`Global Express ${tag}`],
      );
      ambiguousCarrierAId = a.rows[0].id;
      const b = await owner.query(
        `INSERT INTO carrier (name) VALUES ($1) RETURNING id`,
        [`Global Express Logistics ${tag}`],
      );
      ambiguousCarrierBId = b.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM carrier WHERE id IN ($1, $2, $3)`, [
        exactCarrierId,
        ambiguousCarrierAId,
        ambiguousCarrierBId,
      ]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('resolves an exact case-insensitive name match unambiguously', async () => {
    const result = await withTenantTx({ internal: true }, (client) =>
      matchCarrierName(client, `acme freight co ${tag}`.toUpperCase()),
    );
    expect(result.carrierId).toBe(exactCarrierId);
    expect(result.candidates).toEqual([]);
  });

  it('surfaces multiple substring matches as candidates, never guessing one', async () => {
    const result = await withTenantTx({ internal: true }, (client) =>
      matchCarrierName(client, `Global Express ${tag}`),
    );
    // "Global Express {tag}" is an exact match for carrier A AND a substring
    // match target for carrier B ("Global Express Logistics {tag}" contains
    // it) -- but exact-match resolution short-circuits before the fuzzy
    // substring pass runs, so this resolves unambiguously to A.
    expect(result.carrierId).toBe(ambiguousCarrierAId);
    expect(result.candidates).toEqual([]);
  });

  it('surfaces genuinely ambiguous substring matches as candidates when no exact match exists', async () => {
    const result = await withTenantTx({ internal: true }, (client) =>
      matchCarrierName(client, `Global`),
    );
    expect(result.carrierId).toBeNull();
    const ids = result.candidates.map((c) => c.carrierId).sort();
    expect(ids).toEqual([ambiguousCarrierAId, ambiguousCarrierBId].sort());
  });

  it('returns zero candidates for a name matching no carrier', async () => {
    const result = await withTenantTx({ internal: true }, (client) =>
      matchCarrierName(client, `Definitely Nonexistent Carrier ${tag}`),
    );
    expect(result.carrierId).toBeNull();
    expect(result.candidates).toEqual([]);
  });

  it('treats a blank/whitespace-only name as no match, not an error', async () => {
    const result = await withTenantTx({ internal: true }, (client) => matchCarrierName(client, '   '));
    expect(result.carrierId).toBeNull();
    expect(result.candidates).toEqual([]);
  });
});
