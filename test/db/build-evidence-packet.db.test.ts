import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { buildEvidencePacket, BuildEvidencePacketError } from '../../src/modules/disputes/build-evidence-packet.js';

/**
 * 86e2zfhkp: deterministic evidence packets for a dispute (P4.C.3).
 */
describe('buildEvidencePacket (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  let carrierId: string;
  const tag = `evp-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('EVP', $1) RETURNING id`, [tag]);
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
      await owner.query(`DELETE FROM dispute_line WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM dispute WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM computation_trace WHERE client_id = $1`, [clientId]);
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

  async function seedDisputeWithFinding(
    client: pg.PoolClient,
    opts: { withTrace?: boolean } = {},
  ): Promise<{ disputeId: string; disputeLineId: string; findingId: string; auditRunId: string }> {
    const inv = await client.query(
      `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version)
       VALUES ($1, $2, '210', $3, 'USD', 'test') RETURNING id`,
      [clientId, carrierId, `INV-${tag}-${Math.random().toString(36).slice(2)}`],
    );
    const invoiceId = inv.rows[0].id;

    const run = await client.query(
      `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'test', 'SCORED') RETURNING id`,
      [clientId, invoiceId],
    );
    const auditRunId = run.rows[0].id;

    const cf = await client.query(
      `INSERT INTO charge_fact (client_id, invoice_id, code, category, amount, currency)
       VALUES ($1, $2, '400', 'LINEHAUL', '1000.0000', 'USD') RETURNING id`,
      [clientId, invoiceId],
    );
    const chargeFactId = cf.rows[0].id;

    if (opts.withTrace) {
      await client.query(
        `INSERT INTO computation_trace (client_id, audit_run_id, step_order, step, pinned_inputs)
         VALUES ($1, $2, 1, '{"op":"compare"}'::jsonb, '{}'::jsonb)`,
        [clientId, auditRunId],
      );
      await client.query(
        `INSERT INTO computation_trace (client_id, audit_run_id, step_order, step, pinned_inputs)
         VALUES ($1, $2, 0, '{"op":"lookup"}'::jsonb, '{}'::jsonb)`,
        [clientId, auditRunId],
      );
    }

    const vf = await client.query<{ id: string }>(
      `INSERT INTO variance_finding
         (client_id, audit_run_id, charge_fact_id, criterion_id, rule_version_id, direction, variance_amount, currency, status, evaluated_expr)
       SELECT $1, $2, $3, c.id, rv.id, 'OVERCHARGE', '100.0000', 'USD', 'accepted', '{}'::jsonb
       FROM criterion c JOIN rule r ON r.slug = 'contract-rate_variance'
       JOIN rule_version rv ON rv.rule_id = r.id
       WHERE c.criterion_key = 'CONTRACT.RATE_VARIANCE' ORDER BY rv.recorded_at DESC LIMIT 1 RETURNING id`,
      [clientId, auditRunId, chargeFactId],
    );
    const findingId = vf.rows[0]!.id;

    const dispute = await client.query<{ id: string }>(
      `INSERT INTO dispute (client_id, carrier_id, status, amount_claimed, currency) VALUES ($1, $2, 'draft', '100.0000', 'USD') RETURNING id`,
      [clientId, carrierId],
    );
    const disputeId = dispute.rows[0]!.id;

    const line = await client.query<{ id: string }>(
      `INSERT INTO dispute_line (client_id, dispute_id, variance_finding_id, amount, currency) VALUES ($1, $2, $3, '100.0000', 'USD') RETURNING id`,
      [clientId, disputeId, findingId],
    );
    const disputeLineId = line.rows[0]!.id;

    return { disputeId, disputeLineId, findingId, auditRunId };
  }

  it('assembles a packet with the defensibility chain and ordered computation trace', async () => {
    const packet = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const seeded = await seedDisputeWithFinding(c, { withTrace: true });
      return { packet: await buildEvidencePacket(c, clientId, seeded.disputeId), seeded };
    });

    expect(packet.packet.disputeId).toBe(packet.seeded.disputeId);
    expect(packet.packet.lines).toHaveLength(1);
    const line = packet.packet.lines[0]!;
    expect(line.disputeLineId).toBe(packet.seeded.disputeLineId);
    expect(line.varianceFindingId).toBe(packet.seeded.findingId);
    expect(line.defensibilityChain.finding.id).toBe(packet.seeded.findingId);
    expect(line.computationTrace.map((t) => t.stepOrder)).toEqual([0, 1]);
  });

  it('returns an empty computation trace when none was recorded', async () => {
    const packet = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const seeded = await seedDisputeWithFinding(c);
      return buildEvidencePacket(c, clientId, seeded.disputeId);
    });

    expect(packet.lines[0]!.computationTrace).toEqual([]);
  });

  it('fails closed for a dispute belonging to a different tenant', async () => {
    const otherClient = await pool.connect();
    let otherClientId: string;
    try {
      const c = await otherClient.query(`INSERT INTO client (name, slug) VALUES ('EVP-OTHER', $1) RETURNING id`, [`${tag}-other`]);
      otherClientId = c.rows[0].id;
    } finally {
      otherClient.release();
    }

    const disputeId = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const seeded = await seedDisputeWithFinding(c);
      return seeded.disputeId;
    });

    await withTenantTx({ clientIds: [otherClientId] }, (c) =>
      expect(buildEvidencePacket(c, otherClientId, disputeId)).rejects.toBeInstanceOf(BuildEvidencePacketError),
    );

    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM client WHERE id = $1`, [otherClientId]);
    } finally {
      owner.release();
    }
  });

  it('fails closed for an unknown dispute id', async () => {
    await withTenantTx({ clientIds: [clientId] }, (c) =>
      expect(buildEvidencePacket(c, clientId, '00000000-0000-0000-0000-000000000000'))
        .rejects.toBeInstanceOf(BuildEvidencePacketError),
    );
  });
});
