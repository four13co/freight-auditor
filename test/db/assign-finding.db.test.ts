import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { assignFinding } from '../../src/modules/findings/assign-finding.js';
import { listFindings } from '../../src/modules/findings/list-findings.js';

/**
 * 86e37r2t8: self-assign/unassign write path. Covers the UPDATE
 * variance_finding.assigned_to_user_id, the audit ledger entry, and
 * cross-tenant isolation on the write itself.
 */
describe('assignFinding (DB)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let clientBId: string;
  let carrierId: string;
  let analystUserId: string;
  const tag = `af-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('AF-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const b = await owner.query(`INSERT INTO client (name, slug) VALUES ('AF-B', $1) RETURNING id`, [`${tag}-b`]);
      clientBId = b.rows[0].id;
      const carrier = await owner.query(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [`Carrier-${tag}`]);
      carrierId = carrier.rows[0].id;
      const user = await owner.query(
        `INSERT INTO app_user (email, full_name, is_internal) VALUES ($1, 'Analyst A', true) RETURNING id`,
        [`analyst-${tag}@example.com`],
      );
      analystUserId = user.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM finding_assignment_event WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM variance_finding WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM charge_fact WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM payment_gate_decision WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM audit_run WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM invoice WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM carrier WHERE id = $1`, [carrierId]);
      await owner.query(`DELETE FROM app_user WHERE id = $1`, [analystUserId]);
      await owner.query(`DELETE FROM client WHERE id IN ($1, $2)`, [clientAId, clientBId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  /** Seeds one full variance_finding row (through charge_fact/invoice/audit_run) for a client. */
  async function seedFinding(
    client: pg.PoolClient,
    opts: { clientId: string; variance?: string },
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
         (client_id, audit_run_id, charge_fact_id, criterion_id, rule_version_id, direction, variance_amount, currency, status, evaluated_expr)
       SELECT $1, $2, $3, c.id, rv.id, 'OVERCHARGE', $4, 'USD', 'open', '{}'::jsonb
       FROM criterion c JOIN rule r ON r.slug = 'contract-rate_variance'
       JOIN rule_version rv ON rv.rule_id = r.id
       WHERE c.criterion_key = 'CONTRACT.RATE_VARIANCE' ORDER BY rv.recorded_at DESC LIMIT 1 RETURNING id`,
      [opts.clientId, auditRunId, chargeFactId, opts.variance ?? '600.0000'],
    );
    return vf.rows[0].id;
  }

  it('AC1: assigns the finding to the given userId and writes a finding.assigned audit event', async () => {
    const { findingRow, ledger } = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const id = await seedFinding(c, { clientId: clientAId });
      const result = await assignFinding(c, id, analystUserId, analystUserId);
      expect(result.found).toBe(true);

      const row = await c.query(`SELECT assigned_to_user_id FROM variance_finding WHERE id = $1`, [id]);
      const ledger = await c.query(
        `SELECT event, actor_kind, actor_user_id, detail FROM audit_event WHERE entity = 'variance_finding' AND entity_id = $1`,
        [id],
      );
      return { findingRow: row.rows[0], ledger: ledger.rows[0] };
    });

    expect(findingRow.assigned_to_user_id).toBe(analystUserId);
    expect(ledger).toMatchObject({
      event: 'finding.assigned',
      actor_kind: 'analyst',
      actor_user_id: analystUserId,
      detail: expect.objectContaining({ assignedToUserId: analystUserId }),
    });
  });

  it('unassigns (assigned_to_user_id back to NULL) and writes a finding.unassigned audit event', async () => {
    const { findingRow, ledger } = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const id = await seedFinding(c, { clientId: clientAId });
      await assignFinding(c, id, analystUserId, analystUserId);
      const result = await assignFinding(c, id, null, analystUserId);
      expect(result.found).toBe(true);

      const row = await c.query(`SELECT assigned_to_user_id FROM variance_finding WHERE id = $1`, [id]);
      // Both writes happen inside one transaction here, so now() (and thus
      // recorded_at) is IDENTICAL for both audit_event rows -- an ORDER BY
      // recorded_at tiebreak would be nondeterministic between them.
      // deterministicAuditEventId's own event-string input already makes the
      // two rows distinguishable, so filter on that instead of ordering.
      const ledger = await c.query(
        `SELECT event, detail FROM audit_event WHERE entity = 'variance_finding' AND entity_id = $1 AND event = 'finding.unassigned'`,
        [id],
      );
      return { findingRow: row.rows[0], ledger: ledger.rows[0] };
    });

    expect(findingRow.assigned_to_user_id).toBeNull();
    expect(ledger).toMatchObject({ event: 'finding.unassigned', detail: expect.objectContaining({ assignedToUserId: null }) });
  });

  it('AC5-equivalent: a finding_id outside the caller tenant scope affects zero rows (found: false)', async () => {
    const id = await withTenantTx({ clientIds: [clientAId], internal: true }, (c) =>
      seedFinding(c, { clientId: clientAId }),
    );

    const result = await withTenantTx({ clientIds: [clientBId], internal: false }, (c) =>
      assignFinding(c, id, analystUserId, analystUserId),
    );
    expect(result.found).toBe(false);

    const stillUnassigned = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const row = await c.query(`SELECT assigned_to_user_id FROM variance_finding WHERE id = $1`, [id]);
      return row.rows[0].assigned_to_user_id;
    });
    expect(stillUnassigned).toBeNull();
  });

  it('listFindings reflects the assignment after assignFinding, and the assignee filter narrows to it', async () => {
    await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const assignedId = await seedFinding(c, { clientId: clientAId, variance: '700.0000' });
      const unassignedId = await seedFinding(c, { clientId: clientAId, variance: '650.0000' });
      await assignFinding(c, assignedId, analystUserId, analystUserId);

      const all = await listFindings(c, { clientIds: [clientAId] });
      const assignedRow = all.find((r) => r.id === assignedId);
      const unassignedRow = all.find((r) => r.id === unassignedId);
      expect(assignedRow?.assignedToUserId).toBe(analystUserId);
      expect(unassignedRow?.assignedToUserId).toBeNull();

      const mine = await listFindings(c, { clientIds: [clientAId], assignedToUserId: analystUserId });
      const mineIds = mine.map((r) => r.id);
      expect(mineIds).toContain(assignedId);
      expect(mineIds).not.toContain(unassignedId);
    });
  });

  it('Review fix (86e37r2t8): an assign/unassign/assign/unassign toggle writes 4 distinct audit_event rows, none dropped by ON CONFLICT', async () => {
    await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const id = await seedFinding(c, { clientId: clientAId });

      await assignFinding(c, id, analystUserId, analystUserId);
      await assignFinding(c, id, null, analystUserId);
      await assignFinding(c, id, analystUserId, analystUserId);
      await assignFinding(c, id, null, analystUserId);

      const ledger = await c.query(
        `SELECT id, event FROM audit_event WHERE entity = 'variance_finding' AND entity_id = $1`,
        [id],
      );
      expect(ledger.rows).toHaveLength(4);
      const ids = ledger.rows.map((r) => r.id);
      expect(new Set(ids).size).toBe(4);
      expect(ledger.rows.filter((r) => r.event === 'finding.assigned')).toHaveLength(2);
      expect(ledger.rows.filter((r) => r.event === 'finding.unassigned')).toHaveLength(2);
    });
  });

  it('AC3: assignedToUserId and minAmount apply together as AND, matching the "Mine, over $500" saved view', async () => {
    await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const mineOverThreshold = await seedFinding(c, { clientId: clientAId, variance: '600.0000' });
      const mineUnderThreshold = await seedFinding(c, { clientId: clientAId, variance: '100.0000' });
      const notMineOverThreshold = await seedFinding(c, { clientId: clientAId, variance: '900.0000' });
      await assignFinding(c, mineOverThreshold, analystUserId, analystUserId);
      await assignFinding(c, mineUnderThreshold, analystUserId, analystUserId);
      // notMineOverThreshold is left unassigned.

      const rows = await listFindings(c, { clientIds: [clientAId], assignedToUserId: analystUserId, minAmount: '500' });
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(mineOverThreshold);
      expect(ids).not.toContain(mineUnderThreshold);
      expect(ids).not.toContain(notMineOverThreshold);
    });
  });
});
