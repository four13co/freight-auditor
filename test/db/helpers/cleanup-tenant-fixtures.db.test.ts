import { describe, it, expect, afterAll } from 'vitest';
import { getPool, closePool } from '../../../src/db/pool.js';
import { cleanupTenantFixtures } from './cleanup-tenant-fixtures.js';

/**
 * 86e30txkx: proves cleanupTenantFixtures deletes a real cross-table chain
 * -- client -> invoice -> audit_run -> variance_finding, plus an audit_event
 * row -- with NO caller-supplied ordering, in the exact shape that broke
 * three separate PRs' hand-written `afterAll` blocks (23503 on audit_run's
 * FK, and on client's FK from audit_event).
 */
describe('cleanupTenantFixtures (DB)', () => {
  const pool = getPool();

  afterAll(async () => {
    await closePool();
  });

  async function seedChain(owner: import('pg').PoolClient, tag: string): Promise<string> {
    const client = await owner.query(
      `INSERT INTO client (name, slug) VALUES ('CTF-A', $1) RETURNING id`,
      [tag],
    );
    const clientId: string = client.rows[0].id;

    const invoice = await owner.query(
      `INSERT INTO invoice (client_id, transaction_set, parser_version) VALUES ($1, '210', 'v1') RETURNING id`,
      [clientId],
    );
    const invoiceId: string = invoice.rows[0].id;

    const auditRun = await owner.query(
      `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'v1', 'SCORED') RETURNING id`,
      [clientId, invoiceId],
    );
    const auditRunId: string = auditRun.rows[0].id;

    await owner.query(
      `INSERT INTO variance_finding (client_id, audit_run_id, criterion_id, rule_version_id, evaluated_expr)
       SELECT $1, $2, c.id, rv.id, '{}'::jsonb
       FROM criterion c JOIN rule r ON r.slug = 'contract-rate_variance'
       JOIN rule_version rv ON rv.rule_id = r.id
       WHERE c.criterion_key = 'CONTRACT.RATE_VARIANCE' ORDER BY rv.recorded_at DESC LIMIT 1`,
      [clientId, auditRunId],
    );

    await owner.query(
      `INSERT INTO audit_event (client_id, entity, event, actor_kind) VALUES ($1, 'test', 'test.seeded', 'system')`,
      [clientId],
    );

    return clientId;
  }

  it('deletes a client -> invoice -> audit_run -> variance_finding chain plus a sibling audit_event row without an FK violation', async () => {
    const owner = await pool.connect();
    let clientId: string;
    try {
      clientId = await seedChain(owner, `ctf-${Date.now()}-a`);
    } finally {
      owner.release();
    }

    await expect(cleanupTenantFixtures(pool, [clientId])).resolves.toBeUndefined();

    const check = await pool.query(`SELECT id FROM client WHERE id = $1`, [clientId]);
    expect(check.rowCount).toBe(0);
  });

  it('cleans up multiple client ids in one call', async () => {
    const owner = await pool.connect();
    let clientIdA: string, clientIdB: string;
    try {
      clientIdA = await seedChain(owner, `ctf-${Date.now()}-b1`);
      clientIdB = await seedChain(owner, `ctf-${Date.now()}-b2`);
    } finally {
      owner.release();
    }

    await cleanupTenantFixtures(pool, [clientIdA, clientIdB]);

    const check = await pool.query(`SELECT id FROM client WHERE id = ANY($1::uuid[])`, [[clientIdA, clientIdB]]);
    expect(check.rowCount).toBe(0);
  });

  it('is a no-op for an empty client id list', async () => {
    await expect(cleanupTenantFixtures(pool, [])).resolves.toBeUndefined();
  });

  it('is a no-op (no error) for a client id with no fixtures', async () => {
    await expect(
      cleanupTenantFixtures(pool, ['00000000-0000-0000-0000-000000000000']),
    ).resolves.toBeUndefined();
  });
});
