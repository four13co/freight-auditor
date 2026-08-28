import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { createClaimFromDispute } from '../../src/modules/claims/create-claim-from-dispute.js';
import { DuplicateClaimedFindingError } from '../../src/modules/claims/detect-duplicate-claimed-finding.js';

/**
 * 86e2zfj4w (P5.A.2). Tests the check wired directly into
 * createClaimFromDispute, not a standalone unwired module -- the #166
 * lesson from earlier this session. Teardown order is deepest-child-first:
 * audit_event, claim, dispute_line, dispute, variance_finding, charge_fact,
 * audit_run, invoice, carrier -> client.
 */
describe('detectDuplicateClaimedFinding, wired into createClaimFromDispute (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  let carrierId: string;
  const tag = `ddcf-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('DDCF', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const carrier = await owner.query(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [`Carrier-${tag}`]);
      carrierId = carrier.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM claim WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM dispute_line WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM dispute WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM variance_finding WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM charge_fact WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM audit_run WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM invoice WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM carrier WHERE id = $1`, [carrierId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  /** Seeds one variance_finding (through invoice/audit_run/charge_fact). */
  async function seedFinding(client: pg.PoolClient): Promise<string> {
    const inv = await client.query(
      `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version)
       VALUES ($1, $2, '210', $3, 'USD', 'test') RETURNING id`,
      [clientId, carrierId, `INV-${tag}-${Math.random().toString(36).slice(2)}`],
    );
    const invoiceId = inv.rows[0].id;
    const run = await client.query(
      `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome)
       VALUES ($1, $2, 'test', 'SCORED') RETURNING id`,
      [clientId, invoiceId],
    );
    const auditRunId = run.rows[0].id;
    const cf = await client.query(
      `INSERT INTO charge_fact (client_id, invoice_id, code, category, amount, currency)
       VALUES ($1, $2, '400', 'LINEHAUL', '1000.0000', 'USD') RETURNING id`,
      [clientId, invoiceId],
    );
    const chargeFactId = cf.rows[0].id;
    const vf = await client.query(
      `INSERT INTO variance_finding
         (client_id, audit_run_id, charge_fact_id, criterion_id, rule_version_id, direction, variance_amount, currency, status, evaluated_expr)
       SELECT $1, $2, $3, c.id, rv.id, 'OVERCHARGE', '100.0000', 'USD', 'open', '{}'::jsonb
       FROM criterion c JOIN rule r ON r.slug = 'contract-rate_variance'
       JOIN rule_version rv ON rv.rule_id = r.id
       WHERE c.criterion_key = 'CONTRACT.RATE_VARIANCE' ORDER BY rv.recorded_at DESC LIMIT 1
       RETURNING id`,
      [clientId, auditRunId, chargeFactId],
    );
    return vf.rows[0].id;
  }

  async function seedAcceptedDispute(client: pg.PoolClient, findingId: string): Promise<string> {
    const d = await client.query(
      `INSERT INTO dispute (client_id, status, amount_claimed, currency) VALUES ($1, 'accepted', '100.0000', 'USD') RETURNING id`,
      [clientId],
    );
    const disputeId = d.rows[0].id;
    await client.query(
      `INSERT INTO dispute_line (client_id, dispute_id, variance_finding_id, amount, currency) VALUES ($1, $2, $3, '100.0000', 'USD')`,
      [clientId, disputeId, findingId],
    );
    return disputeId;
  }

  it('allows claiming the first dispute that carries a given finding', async () => {
    const result = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const findingId = await seedFinding(c);
      const disputeId = await seedAcceptedDispute(c, findingId);
      return createClaimFromDispute(c, { clientId, disputeId });
    });
    expect(result.created).toBe(true);
  });

  it('rejects claiming a second dispute that shares a finding with an already-claimed dispute', async () => {
    await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const findingId = await seedFinding(c);
      const firstDisputeId = await seedAcceptedDispute(c, findingId);
      const secondDisputeId = await seedAcceptedDispute(c, findingId);

      const first = await createClaimFromDispute(c, { clientId, disputeId: firstDisputeId });
      expect(first.created).toBe(true);

      await expect(createClaimFromDispute(c, { clientId, disputeId: secondDisputeId }))
        .rejects.toBeInstanceOf(DuplicateClaimedFindingError);

      const count = await c.query(`SELECT count(*)::int AS n FROM claim WHERE client_id = $1 AND dispute_id = $2`, [
        clientId, secondDisputeId,
      ]);
      expect(count.rows[0].n).toBe(0);
    });
  });

  it('allows two disputes to share a finding as long as only one is ever claimed', async () => {
    await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const findingId = await seedFinding(c);
      const firstDisputeId = await seedAcceptedDispute(c, findingId);
      const secondDisputeId = await seedAcceptedDispute(c, findingId);

      // Neither has been claimed yet -- both disputes existing with the shared
      // finding is not itself a violation, only claiming both is.
      const lineCount = await c.query(
        `SELECT count(*)::int AS n FROM dispute_line WHERE client_id = $1 AND variance_finding_id = $2`,
        [clientId, findingId],
      );
      expect(lineCount.rows[0].n).toBe(2);

      const result = await createClaimFromDispute(c, { clientId, disputeId: firstDisputeId });
      expect(result.created).toBe(true);
      void secondDisputeId;
    });
  });
});
