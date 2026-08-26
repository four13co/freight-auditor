import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { closePool, getPool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { persistTightenConflict } from '../../src/modules/rubric-resolver/persist-tighten-conflict.js';

describe('non-monotonic tightening conflicts (DB)', () => {
  let pool: pg.Pool;
  let clientA: string;
  let clientB: string;
  const tag = `tighten-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    clientA = (await pool.query(`INSERT INTO client (name, slug) VALUES ('Tighten A', $1) RETURNING id`, [`${tag}-a`])).rows[0].id;
    clientB = (await pool.query(`INSERT INTO client (name, slug) VALUES ('Tighten B', $1) RETURNING id`, [`${tag}-b`])).rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM resolution_conflict WHERE tenant_id IN ($1, $2)`, [clientA, clientB]);
    await pool.query(`DELETE FROM client WHERE id IN ($1, $2)`, [clientA, clientB]);
    await closePool();
  });

  it('deduplicates retry-equivalent evidence and enforces tenant visibility', async () => {
    const input = {
      tenantId: clientA, criterionKey: 'STD.TEST',
      baseRuleVersionId: '11111111-1111-4111-8111-111111111111',
      attemptedRuleVersionId: '21111111-1111-4111-8111-111111111111',
      proof: { monotonic: false as const, reason: 'BOUND_WEAKENED' as const },
    };
    const written = await withTenantTx({ clientIds: [clientA], internal: false }, async (db) => ({
      first: await persistTightenConflict(db, input),
      second: await persistTightenConflict(db, input),
    }));
    expect(written.first.created).toBe(true);
    expect(written.second).toEqual({ id: written.first.id, created: false });

    const visibleToB = await withTenantTx({ clientIds: [clientB], internal: false }, (db) =>
      db.query(`SELECT id FROM resolution_conflict WHERE id = $1`, [written.first.id]));
    expect(visibleToB.rowCount).toBe(0);
  });
});
