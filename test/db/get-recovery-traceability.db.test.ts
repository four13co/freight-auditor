import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { getRecoveryTraceability, GetRecoveryTraceabilityError } from '../../src/modules/claims/get-recovery-traceability.js';

/**
 * 86e2zfj7g: recovery-to-clause traceability check (P5.A.7), read against
 * real Postgres.
 */
describe('getRecoveryTraceability (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  let carrierId: string;
  let clauseId: string;
  const tag = `rt-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('RT', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const carrier = await owner.query(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [`Carrier-${tag}`]);
      carrierId = carrier.rows[0].id;
      const contract = await owner.query(`INSERT INTO contract (client_id, carrier_id, name) VALUES ($1, $2, 'RT contract') RETURNING id`, [clientId, carrierId]);
      const version = await owner.query(
        `INSERT INTO contract_version (client_id, contract_id, valid_from) VALUES ($1, $2, '2026-01-01') RETURNING id`,
        [clientId, contract.rows[0].id],
      );
      const clause = await owner.query(
        `INSERT INTO contract_clause (client_id, contract_version_id, clause_ref) VALUES ($1, $2, '4.2') RETURNING id`,
        [clientId, version.rows[0].id],
      );
      clauseId = clause.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM recovery_event WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM claim WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM dispute_line WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM dispute WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM variance_finding WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM charge_fact WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM audit_run WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM invoice WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM contract_clause WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM contract_version WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM contract WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM carrier WHERE id = $1`, [carrierId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  async function seedFinding(client: pg.PoolClient, opts: { withClause?: boolean }): Promise<string> {
    const inv = await client.query(
      `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version)
       VALUES ($1, $2, '210', $3, 'USD', 'test') RETURNING id`,
      [clientId, carrierId, `INV-${tag}-${Math.random().toString(36).slice(2)}`],
    );
    const run = await client.query(
      `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'test', 'SCORED') RETURNING id`,
      [clientId, inv.rows[0].id],
    );
    const cf = await client.query(
      `INSERT INTO charge_fact (client_id, invoice_id, code, category, amount, currency) VALUES ($1, $2, '400', 'LINEHAUL', '1000.0000', 'USD') RETURNING id`,
      [clientId, inv.rows[0].id],
    );
    const vf = await client.query<{ id: string }>(
      `INSERT INTO variance_finding
         (client_id, audit_run_id, charge_fact_id, criterion_id, rule_version_id, direction, variance_amount, currency, status, evaluated_expr, clause_id)
       SELECT $1, $2, $3, c.id, rv.id, 'OVERCHARGE', '100.0000', 'USD', 'accepted', '{}'::jsonb, $4
       FROM criterion c JOIN rule r ON r.slug = 'contract-rate_variance'
       JOIN rule_version rv ON rv.rule_id = r.id
       WHERE c.criterion_key = 'CONTRACT.RATE_VARIANCE' ORDER BY rv.recorded_at DESC LIMIT 1 RETURNING id`,
      [clientId, run.rows[0].id, cf.rows[0].id, opts.withClause ? clauseId : null],
    );
    return vf.rows[0]!.id;
  }

  it('traces directly when the recovery_event carries a cited variance_finding_id', async () => {
    const result = await withTenantTx({ clientIds: [clientId], internal: true }, async (client) => {
      const findingId = await seedFinding(client, { withClause: true });
      const claim = await client.query<{ id: string }>(`INSERT INTO claim (client_id, amount_claimed, currency, status) VALUES ($1, '100.0000', 'USD', 'open') RETURNING id`, [clientId]);
      const event = await client.query<{ id: string }>(
        `INSERT INTO recovery_event (client_id, claim_id, variance_finding_id, amount_recovered, currency) VALUES ($1, $2, $3, '100.0000', 'USD') RETURNING id`,
        [clientId, claim.rows[0]!.id, findingId],
      );
      return getRecoveryTraceability(client, clientId, event.rows[0]!.id);
    });

    expect(result.traceable).toBe(true);
    expect(result.path).toBe('DIRECT');
  });

  it('traces indirectly via the claim dispute when no direct variance_finding_id is set', async () => {
    const result = await withTenantTx({ clientIds: [clientId], internal: true }, async (client) => {
      const findingId = await seedFinding(client, { withClause: true });
      const dispute = await client.query<{ id: string }>(`INSERT INTO dispute (client_id, carrier_id, status) VALUES ($1, $2, 'accepted') RETURNING id`, [clientId, carrierId]);
      await client.query(`INSERT INTO dispute_line (client_id, dispute_id, variance_finding_id, amount, currency) VALUES ($1, $2, $3, '100.0000', 'USD')`, [clientId, dispute.rows[0]!.id, findingId]);
      const claim = await client.query<{ id: string }>(
        `INSERT INTO claim (client_id, dispute_id, amount_claimed, currency, status) VALUES ($1, $2, '100.0000', 'USD', 'open') RETURNING id`,
        [clientId, dispute.rows[0]!.id],
      );
      const event = await client.query<{ id: string }>(
        `INSERT INTO recovery_event (client_id, claim_id, amount_recovered, currency) VALUES ($1, $2, '100.0000', 'USD') RETURNING id`,
        [clientId, claim.rows[0]!.id],
      );
      return getRecoveryTraceability(client, clientId, event.rows[0]!.id);
    });

    expect(result.traceable).toBe(true);
    expect(result.path).toBe('INDIRECT');
  });

  it('is untraceable for a claim with no dispute and no direct variance_finding_id', async () => {
    const result = await withTenantTx({ clientIds: [clientId], internal: true }, async (client) => {
      const claim = await client.query<{ id: string }>(`INSERT INTO claim (client_id, amount_claimed, currency, status) VALUES ($1, '100.0000', 'USD', 'open') RETURNING id`, [clientId]);
      const event = await client.query<{ id: string }>(
        `INSERT INTO recovery_event (client_id, claim_id, amount_recovered, currency) VALUES ($1, $2, '100.0000', 'USD') RETURNING id`,
        [clientId, claim.rows[0]!.id],
      );
      return getRecoveryTraceability(client, clientId, event.rows[0]!.id);
    });

    expect(result.traceable).toBe(false);
    expect(result.path).toBe('UNTRACEABLE');
  });

  it('fails not-found for an unknown recovery_event id', async () => {
    await expect(
      withTenantTx({ clientIds: [clientId] }, (client) =>
        getRecoveryTraceability(client, clientId, '00000000-0000-0000-0000-000000000000'),
      ),
    ).rejects.toBeInstanceOf(GetRecoveryTraceabilityError);
  });
});
