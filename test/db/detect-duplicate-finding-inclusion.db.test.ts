import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { detectDuplicateFindingInclusion } from '../../src/modules/findings/detect-duplicate-finding-inclusion.js';

/**
 * 86e2zfhj6: guards against including the same finding in two different
 * dispute-creation calls (P4.C.2).
 */
describe('detectDuplicateFindingInclusion (DB)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let clientBId: string;
  let carrierId: string;
  const tag = `ddfi-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('DDFI-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const b = await owner.query(`INSERT INTO client (name, slug) VALUES ('DDFI-B', $1) RETURNING id`, [`${tag}-b`]);
      clientBId = b.rows[0].id;
      const carrier = await owner.query(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [`Carrier-${tag}`]);
      carrierId = carrier.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM variance_finding WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM charge_fact WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM audit_run WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM invoice WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM carrier WHERE id = $1`, [carrierId]);
      await owner.query(`DELETE FROM client WHERE id IN ($1, $2)`, [clientAId, clientBId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  async function seedFinding(client: pg.PoolClient, opts: { clientId: string; status?: string }): Promise<string> {
    const inv = await client.query(
      `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version)
       VALUES ($1, $2, '210', $3, 'USD', 'test') RETURNING id`,
      [opts.clientId, carrierId, `INV-${tag}-${Math.random().toString(36).slice(2)}`],
    );
    const invoiceId = inv.rows[0].id;

    const run = await client.query(
      `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'test', 'SCORED') RETURNING id`,
      [opts.clientId, invoiceId],
    );
    const auditRunId = run.rows[0].id;

    const cf = await client.query(
      `INSERT INTO charge_fact (client_id, invoice_id, code, category, amount, currency)
       VALUES ($1, $2, '400', 'LINEHAUL', '1000.0000', 'USD') RETURNING id`,
      [opts.clientId, invoiceId],
    );
    const chargeFactId = cf.rows[0].id;

    const vf = await client.query(
      `INSERT INTO variance_finding
         (client_id, audit_run_id, charge_fact_id, criterion_id, rule_version_id, direction, variance_amount, currency, status, evaluated_expr)
       SELECT $1, $2, $3, c.id, rv.id, 'OVERCHARGE', '100.0000', 'USD', $4, '{}'::jsonb
       FROM criterion c JOIN rule r ON r.slug = 'contract-rate_variance'
       JOIN rule_version rv ON rv.rule_id = r.id
       WHERE c.criterion_key = 'CONTRACT.RATE_VARIANCE' ORDER BY rv.recorded_at DESC LIMIT 1 RETURNING id`,
      [opts.clientId, auditRunId, chargeFactId, opts.status ?? 'accepted'],
    );
    return vf.rows[0].id;
  }

  it('flags findings already queued_for_dispute or disputed as duplicates', async () => {
    const result = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const queued = await seedFinding(client, { clientId: clientAId, status: 'queued_for_dispute' });
      const disputed = await seedFinding(client, { clientId: clientAId, status: 'disputed' });
      const accepted = await seedFinding(client, { clientId: clientAId, status: 'accepted' });
      return detectDuplicateFindingInclusion(client, { clientId: clientAId, findingIds: [queued, disputed, accepted] });
    });

    expect(result.duplicateFindingIds).toHaveLength(2);
    expect(result.eligibleFindingIds).toHaveLength(1);
  });

  it('treats a finding reverted back to accepted after a rejected dispute as eligible again', async () => {
    const result = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const reverted = await seedFinding(client, { clientId: clientAId, status: 'accepted' });
      return detectDuplicateFindingInclusion(client, { clientId: clientAId, findingIds: [reverted] });
    });

    expect(result.duplicateFindingIds).toHaveLength(0);
    expect(result.eligibleFindingIds).toHaveLength(1);
  });

  it('does not see findings belonging to a different tenant', async () => {
    const queuedForB = await withTenantTx({ clientIds: [clientBId] }, (client) =>
      seedFinding(client, { clientId: clientBId, status: 'queued_for_dispute' }),
    );

    const result = await withTenantTx({ clientIds: [clientAId] }, (client) =>
      detectDuplicateFindingInclusion(client, { clientId: clientAId, findingIds: [queuedForB] }),
    );

    expect(result.duplicateFindingIds).toHaveLength(0);
    expect(result.eligibleFindingIds).toHaveLength(1);
  });
});
