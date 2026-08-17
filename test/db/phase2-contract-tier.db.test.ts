import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { parse210 } from '../../src/modules/ingestion/parse-210.js';
import { evaluateInvoice } from '../../src/modules/evaluator/evaluate-invoice.js';
import { persistAuditRun } from '../../src/modules/evaluator/persist.js';
import { CONTRACT_RUBRIC } from '../../src/modules/rubric-resolver/contract-rubric.js';
import { lookupContractRate } from '../../src/modules/rate-engine/rate-lookup.js';
import { GOLDEN_210, testCategorize } from '../fixtures/edi-golden.js';

/**
 * Phase 2 CONTRACT-tier persistence + rate-lookup contract (ClickUp 86e25te91)
 * — the e2e side: a real contract_rate row resolved through withTenantTx feeds
 * a contract-scoped evaluateInvoice run, whose $ variance rollup persists to
 * the scorecard (the column evaluate-invoice.ts reserved since Phase 1).
 */
describe('Phase 2 CONTRACT-tier (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  let carrierId: string;
  let contractId: string;
  let contractVersionId: string;
  const tag = `p2-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('P2', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      // No scac_code seeded (nullable; carrier has no client_id, so this test's
      // carrier row is tracked by id for cleanup instead of a tenant scope).
      const carrier = await owner.query(`INSERT INTO carrier (name) VALUES ('Test Carrier') RETURNING id`);
      carrierId = carrier.rows[0].id;
      const contract = await owner.query(
        `INSERT INTO contract (client_id, carrier_id, name) VALUES ($1, $2, 'Test Contract') RETURNING id`,
        [clientId, carrierId],
      );
      contractId = contract.rows[0].id;
      const version = await owner.query(
        `INSERT INTO contract_version (client_id, contract_id, version_label, valid_from) VALUES ($1, $2, 'v1', CURRENT_DATE) RETURNING id`,
        [clientId, contractId],
      );
      contractVersionId = version.rows[0].id;
      await owner.query(
        `INSERT INTO contract_rate (client_id, contract_version_id, category, rate, currency) VALUES ($1, $2, 'LINEHAUL', 900.00, 'USD')`,
        [clientId, contractVersionId],
      );
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      // variance_finding before audit_run (86e2v17p5's derivation now writes
      // here too -- same FK-ordering fix as phase1-persist.db.test.ts).
      await owner.query(`DELETE FROM variance_finding WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM scorecard WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM charge_finding WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM gate_failure WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM audit_run WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM charge_fact WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM invoice WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM contract_rate WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM contract_version WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM contract WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM carrier WHERE id = $1`, [carrierId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('AC1/AC2 e2e: real contract_rate lookup through withTenantTx feeds a CONTRACT-scoped run whose $ variance persists to the scorecard', async () => {
    const inv = parse210(GOLDEN_210, testCategorize); // billed LINEHAUL = 1000.00
    const row = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const rate = await lookupContractRate(c, contractVersionId, 'LINEHAUL');
      expect(rate).not.toBeNull(); // sanity: the seeded rate resolves
      const result = evaluateInvoice(inv, CONTRACT_RUBRIC, { linehaulRate: rate });
      const p = await persistAuditRun(c, { clientId, invoice: inv, result, rubricSnapshotId: null });
      const sc = await c.query(
        `SELECT variance_count, total_overcharge, total_undercharge FROM scorecard WHERE audit_run_id = $1`,
        [p.auditRunId],
      );
      return { outcome: result.outcome, scorecard: sc.rows[0] };
    });
    expect(row.outcome).toBe('SCORED');
    // billed 1000.00 - contracted 900.00 = 100.00 overcharge, persisted for real.
    expect(row.scorecard).toMatchObject({ variance_count: 1, total_overcharge: '100.0000', total_undercharge: '0.0000' });
  });

  it('AC3 e2e: a rate-lookup miss (unknown category) resolves to null, never a guessed rate', async () => {
    const result = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      return lookupContractRate(c, contractVersionId, 'FUEL'); // no FUEL rate seeded
    });
    expect(result).toBeNull();
  });
});
