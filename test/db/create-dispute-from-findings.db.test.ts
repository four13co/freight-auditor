import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { seedCriteria } from '../../scripts/seed-criteria.mjs';
import {
  createDisputeFromFindings,
  DisputableFindingsError,
  DuplicateFindingInclusionError,
} from '../../src/modules/disputes/create-dispute-from-findings.js';

/**
 * P4.C.1: dispute creation from analyst-accepted findings. Covers the
 * happy path (one dispute + lines + finding transitions), the empty/
 * retry-after-success case (invariant 3's "duplicate/retry has stable
 * behavior, no duplicate effect"), and the mixed-carrier/currency rejections.
 */
describe('createDisputeFromFindings (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  let carrierAId: string;
  let carrierBId: string;
  const tag = `disp-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    await seedCriteria({ client: pool });
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('Disp', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const ca = await owner.query(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [`Carrier-A-${tag}`]);
      carrierAId = ca.rows[0].id;
      const cb = await owner.query(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [`Carrier-B-${tag}`]);
      carrierBId = cb.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM finding_status_event WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM dispute_line WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM dispute WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM variance_finding WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM charge_fact WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM audit_run WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM invoice WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM carrier WHERE id IN ($1, $2)`, [carrierAId, carrierBId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  async function seedFinding(
    client: pg.PoolClient,
    opts: { carrierId: string; status?: string; variance?: string; currency?: string; direction?: string },
  ): Promise<string> {
    const inv = await client.query(
      `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version)
       VALUES ($1, $2, '210', $3, $4, 'test') RETURNING id`,
      [clientId, opts.carrierId, `INV-${tag}-${Math.random().toString(36).slice(2)}`, opts.currency ?? 'USD'],
    );
    const invoiceId = inv.rows[0].id;
    const run = await client.query(
      `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'test', 'SCORED') RETURNING id`,
      [clientId, invoiceId],
    );
    const auditRunId = run.rows[0].id;
    const vf = await client.query(
      `INSERT INTO variance_finding
         (client_id, audit_run_id, criterion_id, rule_version_id, direction, variance_amount, currency, status, evaluated_expr)
       SELECT $1, $2, c.id, rv.id, $3, $4, $5, $6, '{}'::jsonb
       FROM criterion c JOIN rule r ON r.slug = 'contract-rate_variance'
       JOIN rule_version rv ON rv.rule_id = r.id
       WHERE c.criterion_key = 'CONTRACT.RATE_VARIANCE' ORDER BY rv.recorded_at DESC LIMIT 1 RETURNING id`,
      [clientId, auditRunId, opts.direction ?? 'OVERCHARGE', opts.variance ?? '100.0000', opts.currency ?? 'USD', opts.status ?? 'accepted'],
    );
    return vf.rows[0].id;
  }

  it('creates one dispute + dispute_line per finding and transitions findings to queued_for_dispute', async () => {
    const result = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const f1 = await seedFinding(c, { carrierId: carrierAId, variance: '100.0000' });
      const f2 = await seedFinding(c, { carrierId: carrierAId, variance: '50.5000' });
      const created = await createDisputeFromFindings(c, { clientId, findingIds: [f1, f2] });
      const dispute = await c.query(`SELECT carrier_id, status, amount_claimed, currency FROM dispute WHERE id = $1`, [created.disputeId]);
      const lines = await c.query(`SELECT variance_finding_id FROM dispute_line WHERE dispute_id = $1`, [created.disputeId]);
      const findings = await c.query(`SELECT id, status FROM variance_finding WHERE id = ANY($1::uuid[])`, [[f1, f2]]);
      return { created, dispute: dispute.rows[0], lines: lines.rows, findings: findings.rows };
    });

    expect(result.dispute).toMatchObject({ carrier_id: carrierAId, status: 'draft', amount_claimed: '150.5000', currency: 'USD' });
    expect(result.lines).toHaveLength(2);
    expect(result.findings.every((f) => f.status === 'queued_for_dispute')).toBe(true);
    expect(result.created.amountClaimed).toBe('150.5000');
  });

  it('retrying after success finds zero accepted findings and fails closed (EMPTY_SET), never creating an empty dispute', async () => {
    await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const f1 = await seedFinding(c, { carrierId: carrierAId, variance: '75.0000' });
      const first = await createDisputeFromFindings(c, { clientId, findingIds: [f1] });
      expect(first.disputeId).toBeTruthy();

      const before = await c.query(`SELECT count(*)::int AS n FROM dispute WHERE client_id = $1`, [clientId]);
      await expect(createDisputeFromFindings(c, { clientId, findingIds: [f1] }))
        .rejects.toBeInstanceOf(DisputableFindingsError);
      const after = await c.query(`SELECT count(*)::int AS n FROM dispute WHERE client_id = $1`, [clientId]);
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });
  });

  it('rejects findings spanning more than one carrier without creating a dispute', async () => {
    await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const f1 = await seedFinding(c, { carrierId: carrierAId });
      const f2 = await seedFinding(c, { carrierId: carrierBId });
      const before = await c.query(`SELECT count(*)::int AS n FROM dispute WHERE client_id = $1`, [clientId]);
      await expect(createDisputeFromFindings(c, { clientId, findingIds: [f1, f2] }))
        .rejects.toBeInstanceOf(DisputableFindingsError);
      const after = await c.query(`SELECT count(*)::int AS n FROM dispute WHERE client_id = $1`, [clientId]);
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });
  });

  it('rejects findings spanning more than one currency without creating a dispute', async () => {
    await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const f1 = await seedFinding(c, { carrierId: carrierAId, currency: 'USD' });
      const f2 = await seedFinding(c, { carrierId: carrierAId, currency: 'EUR' });
      await expect(createDisputeFromFindings(c, { clientId, findingIds: [f1, f2] }))
        .rejects.toBeInstanceOf(DisputableFindingsError);
    });
  });

  it('excludes UNDERCHARGE findings from the claim total', async () => {
    const result = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const f1 = await seedFinding(c, { carrierId: carrierAId, variance: '100.0000', direction: 'OVERCHARGE' });
      const f2 = await seedFinding(c, { carrierId: carrierAId, variance: '9999.0000', direction: 'UNDERCHARGE' });
      return createDisputeFromFindings(c, { clientId, findingIds: [f1, f2] });
    });
    expect(result.findingIds).toHaveLength(1);
    expect(result.amountClaimed).toBe('100.0000');
  });

  it('rejects a finding already included on another dispute_line, without creating a second dispute', async () => {
    await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const f1 = await seedFinding(c, { carrierId: carrierAId, variance: '200.0000' });
      // Simulate the finding already sitting on a prior dispute's line
      // directly (rather than relying on createDisputeFromFindings's own
      // status filter) so this test proves the query-time guard itself,
      // not just the incidental status='accepted' fetch filter.
      const priorDispute = await c.query(
        `INSERT INTO dispute (client_id, carrier_id, status, amount_claimed, currency)
         VALUES ($1, $2, 'draft', '200.0000', 'USD') RETURNING id`,
        [clientId, carrierAId],
      );
      await c.query(
        `INSERT INTO dispute_line (client_id, dispute_id, variance_finding_id, amount, currency)
         VALUES ($1, $2, $3, '200.0000', 'USD')`,
        [clientId, priorDispute.rows[0].id, f1],
      );

      const before = await c.query(`SELECT count(*)::int AS n FROM dispute WHERE client_id = $1`, [clientId]);
      const error = await createDisputeFromFindings(c, { clientId, findingIds: [f1] }).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(DuplicateFindingInclusionError);
      expect((error as DuplicateFindingInclusionError).conflictingFindingIds).toEqual([f1]);
      const after = await c.query(`SELECT count(*)::int AS n FROM dispute WHERE client_id = $1`, [clientId]);
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });
  });

  it('enforces the unique index at the database level even if the pre-check were bypassed', async () => {
    await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const f1 = await seedFinding(c, { carrierId: carrierAId, variance: '10.0000' });
      const disputeA = await c.query(
        `INSERT INTO dispute (client_id, carrier_id, status, amount_claimed, currency)
         VALUES ($1, $2, 'draft', '10.0000', 'USD') RETURNING id`,
        [clientId, carrierAId],
      );
      await c.query(
        `INSERT INTO dispute_line (client_id, dispute_id, variance_finding_id, amount, currency)
         VALUES ($1, $2, $3, '10.0000', 'USD')`,
        [clientId, disputeA.rows[0].id, f1],
      );
      const disputeB = await c.query(
        `INSERT INTO dispute (client_id, carrier_id, status, amount_claimed, currency)
         VALUES ($1, $2, 'draft', '10.0000', 'USD') RETURNING id`,
        [clientId, carrierAId],
      );
      await expect(c.query(
        `INSERT INTO dispute_line (client_id, dispute_id, variance_finding_id, amount, currency)
         VALUES ($1, $2, $3, '10.0000', 'USD')`,
        [clientId, disputeB.rows[0].id, f1],
      )).rejects.toMatchObject({ code: '23505' });
    });
  });
});
