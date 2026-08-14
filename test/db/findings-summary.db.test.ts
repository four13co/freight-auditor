import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { getFindingsSummary } from '../../src/modules/findings/findings-summary.js';

/**
 * 86e2u7j0j: GET /api/findings/summary's backing aggregate query. Covers the
 * four KPI-row numbers (recoverableOpen, flaggedToday, withCarriers,
 * recoveredLast30Days) and the empty-tenant zero case.
 */
describe('getFindingsSummary (DB)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let clientBId: string;
  let carrierId: string;
  const tag = `fs-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('FS-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const b = await owner.query(`INSERT INTO client (name, slug) VALUES ('FS-B', $1) RETURNING id`, [`${tag}-b`]);
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
      await owner.query(`DELETE FROM recovery_event WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
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

  /** Seeds one variance_finding row (through charge_fact/invoice/audit_run) for a client, with an optional overriding created_at. */
  async function seedFinding(
    client: pg.PoolClient,
    opts: { clientId: string; status?: string; variance?: string; createdAt?: string },
  ): Promise<string> {
    const inv = await client.query(
      `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version)
       VALUES ($1, $2, '210', $3, 'USD', 'test') RETURNING id`,
      [opts.clientId, carrierId, `INV-${tag}-${Math.random().toString(36).slice(2)}`],
    );
    const invoiceId = inv.rows[0].id;

    const run = await client.query(
      `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome)
       VALUES ($1, $2, 'test', 'SCORED') RETURNING id`,
      [opts.clientId, invoiceId],
    );
    const auditRunId = run.rows[0].id;

    const cf = await client.query(
      `INSERT INTO charge_fact (client_id, invoice_id, code, category, amount, currency)
       VALUES ($1, $2, '400', 'LINEHAUL', '1000.0000', 'USD') RETURNING id`,
      [opts.clientId, invoiceId],
    );
    const chargeFactId = cf.rows[0].id;

    const createdAtClause = opts.createdAt ? `, created_at` : '';
    const createdAtValue = opts.createdAt ? `, $6::timestamptz` : '';
    const params: unknown[] = [
      opts.clientId,
      auditRunId,
      chargeFactId,
      opts.variance ?? '100.0000',
      opts.status ?? 'open',
    ];
    if (opts.createdAt) params.push(opts.createdAt);

    const vf = await client.query(
      `INSERT INTO variance_finding
         (client_id, audit_run_id, charge_fact_id, direction, variance_amount, currency, status${createdAtClause})
       VALUES ($1, $2, $3, 'OVERCHARGE', $4, 'USD', $5${createdAtValue}) RETURNING id`,
      params,
    );
    return vf.rows[0].id;
  }

  it('AC1: recoverableOpen sums variance_amount for open findings only', async () => {
    const summary = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      await seedFinding(c, { clientId: clientAId, status: 'open', variance: '100.0000' });
      await seedFinding(c, { clientId: clientAId, status: 'open', variance: '50.0000' });
      await seedFinding(c, { clientId: clientAId, status: 'closed', variance: '9999.0000' });
      return getFindingsSummary(c);
    });
    expect(summary.recoverableOpen).toBe('150.0000');
  });

  it('AC1: flaggedToday counts findings created today, excluding ones created before today', async () => {
    // Other tests in this file also seed clientAId findings dated today and
    // don't clean up until afterAll (matching list-findings.db.test.ts's
    // convention), so this asserts the *delta* this test's own seeds cause,
    // not an absolute count.
    const before = await withTenantTx({ clientIds: [clientAId], internal: true }, (c) => getFindingsSummary(c));
    const after = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      await seedFinding(c, { clientId: clientAId }); // created_at defaults to now()
      await seedFinding(c, { clientId: clientAId, createdAt: '2020-01-01T00:00:00Z' });
      return getFindingsSummary(c);
    });
    expect(after.flaggedToday - before.flaggedToday).toBe(1);
  });

  it("AC1: withCarriers counts findings in queued_for_dispute or disputed status only", async () => {
    // Delta-based (see the flaggedToday test above) so this doesn't depend on
    // no other test in this file ever using these two statuses.
    const before = await withTenantTx({ clientIds: [clientAId], internal: true }, (c) => getFindingsSummary(c));
    const after = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      await seedFinding(c, { clientId: clientAId, status: 'queued_for_dispute' });
      await seedFinding(c, { clientId: clientAId, status: 'disputed' });
      await seedFinding(c, { clientId: clientAId, status: 'open' });
      await seedFinding(c, { clientId: clientAId, status: 'closed' });
      return getFindingsSummary(c);
    });
    expect(after.withCarriers - before.withCarriers).toBe(2);
  });

  it('AC1: recoveredLast30Days sums recovery_event.amount_recovered within the trailing 30 days only', async () => {
    const summary = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const findingId = await seedFinding(c, { clientId: clientAId, status: 'recovered' });
      await c.query(
        `INSERT INTO recovery_event (client_id, variance_finding_id, amount_recovered, currency, recorded_at)
         VALUES ($1, $2, '75.0000', 'USD', now() - interval '5 days')`,
        [clientAId, findingId],
      );
      await c.query(
        `INSERT INTO recovery_event (client_id, variance_finding_id, amount_recovered, currency, recorded_at)
         VALUES ($1, $2, '9999.0000', 'USD', now() - interval '45 days')`,
        [clientAId, findingId],
      );
      return getFindingsSummary(c);
    });
    expect(summary.recoveredLast30Days).toBe('75.0000');
  });

  it('AC2: a tenant with zero rows gets zeros back, not an error', async () => {
    const summary = await withTenantTx({ clientIds: [clientBId], internal: false }, (c) => getFindingsSummary(c));
    expect(summary).toEqual({
      recoverableOpen: '0',
      flaggedToday: 0,
      withCarriers: 0,
      recoveredLast30Days: '0',
    });
  });

  it('RLS: client B never sees client A totals (tenant isolation)', async () => {
    await withTenantTx({ clientIds: [clientAId], internal: true }, (c) =>
      seedFinding(c, { clientId: clientAId, status: 'open', variance: '500.0000' }),
    );
    const bSummary = await withTenantTx({ clientIds: [clientBId], internal: false }, (c) => getFindingsSummary(c));
    expect(bSummary.recoverableOpen).toBe('0');
  });
});
