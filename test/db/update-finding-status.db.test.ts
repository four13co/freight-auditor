import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { updateFindingStatus } from '../../src/modules/findings/update-finding-status.js';
import { listFindings } from '../../src/modules/findings/list-findings.js';
import { getFindingsSummary } from '../../src/modules/findings/findings-summary.js';

/**
 * 86e2v1xyr: the first mutating write path in the app. Covers the
 * UPDATE variance_finding + INSERT finding_status_event pairing, KPI
 * reflection, and cross-tenant isolation on the write itself.
 */
describe('updateFindingStatus (DB)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let clientBId: string;
  let carrierId: string;
  const tag = `ufs-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('UFS-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const b = await owner.query(`INSERT INTO client (name, slug) VALUES ('UFS-B', $1) RETURNING id`, [`${tag}-b`]);
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
      await owner.query(`DELETE FROM finding_status_event WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
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

  /** Seeds one full variance_finding row (through charge_fact/invoice/audit_run) for a client. */
  async function seedFinding(
    client: pg.PoolClient,
    opts: { clientId: string; status?: string; variance?: string },
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

    const vf = await client.query(
      `INSERT INTO variance_finding
         (client_id, audit_run_id, charge_fact_id, direction, variance_amount, currency, status)
       VALUES ($1, $2, $3, 'OVERCHARGE', $4, 'USD', $5) RETURNING id`,
      [opts.clientId, auditRunId, chargeFactId, opts.variance ?? '100.0000', opts.status ?? 'open'],
    );
    return vf.rows[0].id;
  }

  it('AC1: transitions status and writes a finding_status_event row with the correct from/to/actor', async () => {
    const { findingId, event } = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const id = await seedFinding(c, { clientId: clientAId, status: 'open' });
      const result = await updateFindingStatus(c, id, 'in_review');
      expect(result.found).toBe(true);

      const row = await c.query(`SELECT status FROM variance_finding WHERE id = $1`, [id]);
      const ev = await c.query(
        `SELECT from_status, to_status, actor_kind FROM finding_status_event WHERE variance_finding_id = $1`,
        [id],
      );
      return { findingId: id, event: { status: row.rows[0].status, ...ev.rows[0] } };
    });

    expect(findingId).toBeTruthy();
    expect(event.status).toBe('in_review');
    expect(event.from_status).toBe('open');
    expect(event.to_status).toBe('in_review');
    expect(event.actor_kind).toBe('analyst');
  });

  it('AC2: recoverableOpen no longer includes a finding moved out of open', async () => {
    await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const before = await getFindingsSummary(c);
      const id = await seedFinding(c, { clientId: clientAId, status: 'open', variance: '250.0000' });
      const afterSeed = await getFindingsSummary(c);
      expect(Number(afterSeed.recoverableOpen) - Number(before.recoverableOpen)).toBeCloseTo(250, 4);

      await updateFindingStatus(c, id, 'in_review');
      const afterTransition = await getFindingsSummary(c);
      expect(Number(afterTransition.recoverableOpen)).toBeCloseTo(Number(before.recoverableOpen), 4);
    });
  });

  it('AC5: a finding_id outside the caller tenant scope affects zero rows (found: false)', async () => {
    const id = await withTenantTx({ clientIds: [clientAId], internal: true }, (c) =>
      seedFinding(c, { clientId: clientAId }),
    );

    const result = await withTenantTx({ clientIds: [clientBId], internal: false }, (c) =>
      updateFindingStatus(c, id, 'in_review'),
    );
    expect(result.found).toBe(false);

    const stillOpen = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const row = await c.query(`SELECT status FROM variance_finding WHERE id = $1`, [id]);
      const events = await c.query(`SELECT count(*)::int AS n FROM finding_status_event WHERE variance_finding_id = $1`, [id]);
      return { status: row.rows[0].status, eventCount: events.rows[0].n };
    });
    expect(stillOpen.status).toBe('open');
    expect(stillOpen.eventCount).toBe(0);
  });

  it('AC6: two sequential transitions both appear in finding_status_event, in order', async () => {
    const events = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const id = await seedFinding(c, { clientId: clientAId, status: 'open' });
      await updateFindingStatus(c, id, 'in_review');
      await updateFindingStatus(c, id, 'queued_for_dispute');

      const ev = await c.query(
        `SELECT from_status, to_status FROM finding_status_event WHERE variance_finding_id = $1 ORDER BY recorded_at ASC`,
        [id],
      );
      return ev.rows;
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ from_status: 'open', to_status: 'in_review' });
    expect(events[1]).toMatchObject({ from_status: 'in_review', to_status: 'queued_for_dispute' });
  });

  it('listFindings reflects the updated status after a transition', async () => {
    await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const id = await seedFinding(c, { clientId: clientAId, status: 'open' });
      await updateFindingStatus(c, id, 'closed');
      const rows = await listFindings(c, { clientIds: [clientAId] });
      const row = rows.find((r) => r.id === id);
      expect(row?.status).toBe('closed');
    });
  });
});
