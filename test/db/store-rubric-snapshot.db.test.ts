import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { closePool, getPool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { storeRubricSnapshot } from '../../src/modules/rubric-resolver/store-rubric-snapshot.js';

describe('rubric snapshot deduplication (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  const tag = `snapshot-${Date.now()}`;
  const document = { schemaVersion: 1, resolverVersion: 'resolver-v1', criteria: [{ criterionKey: tag }] };

  beforeAll(async () => {
    pool = getPool();
    clientId = (await pool.query(`INSERT INTO client (name, slug) VALUES ('Snapshot', $1) RETURNING id`, [tag])).rows[0].id;
  });

  afterAll(async () => {
    const hash = (await import('../../src/modules/rubric-resolver/canonicalize-resolved-rubric.js'))
      .canonicalizeResolvedRubricDocument(document).contentHash;
    await pool.query(`DELETE FROM rubric_snapshot WHERE content_hash = $1`, [hash]);
    await pool.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    await closePool();
  });

  it('deduplicates NULL-tenant STANDARD snapshots and isolates tenant snapshots', async () => {
    const global = await withTenantTx({ internal: true }, async (db) => ({
      first: await storeRubricSnapshot(db, null, document),
      second: await storeRubricSnapshot(db, null, document),
    }));
    expect(global.first.created).toBe(true);
    expect(global.second).toEqual({ ...global.first, created: false });

    const tenant = await withTenantTx({ clientIds: [clientId], internal: false }, (db) =>
      storeRubricSnapshot(db, clientId, document));
    expect(tenant.created).toBe(true);
    expect(tenant.id).not.toBe(global.first.id);
    expect(tenant.contentHash).toBe(global.first.contentHash);
  });
});
