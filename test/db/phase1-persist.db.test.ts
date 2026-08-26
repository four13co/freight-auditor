import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { parse210 } from '../../src/modules/ingestion/parse-210.js';
import { parse310 } from '../../src/modules/ingestion/parse-310.js';
import { evaluateInvoice } from '../../src/modules/evaluator/evaluate-invoice.js';
import { persistAuditRun } from '../../src/modules/evaluator/persist.js';
import { GOLDEN_210, MALFORMED_210_NOFOOT, MALFORMED_310_NOCURRENCY, testCategorize } from '../fixtures/edi-golden.js';

/**
 * Phase 1 persistence contract (ClickUp 86e24cy5r) — the e2e side of the
 * acceptance criteria: a parsed invoice's audit result lands in the canonical
 * schema through the real withTenantTx (RLS-bound, non-superuser role), and the
 * shapes match (charge_fact rows, scorecard on SCORED, gate_failure on rejected).
 */
describe('Phase 1 persistence (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  const tag = `p1-${Date.now()}`;
  const createdRunIds: string[] = [];

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('P1', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM audit_replay_manifest WHERE client_id = $1`, [clientId]);
      // Children of the runs first, then invoices, then client.
      // variance_finding before audit_run (86e2v17p5's derivation now writes
      // here too).
      await owner.query(`DELETE FROM variance_finding WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM scorecard WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM charge_finding WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM gate_failure WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM coverage_marker WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM audit_run WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM charge_fact WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM invoice WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('AC1 e2e: golden 210 → charge_fact rows with canonical categories', async () => {
    const inv = parse210(GOLDEN_210, testCategorize);
    const result = evaluateInvoice(inv);
    const persisted = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const p = await persistAuditRun(c, { clientId, invoice: inv, result, rubricSnapshotId: null });
      expect(p.coverageMarkerIds.length).toBeGreaterThan(0);
      const facts = await c.query(
        `SELECT code, category, amount, currency FROM charge_fact WHERE invoice_id = $1 ORDER BY amount DESC`,
        [p.invoiceId],
      );
      return { p, facts: facts.rows };
    });
    createdRunIds.push(persisted.p.auditRunId);
    expect(persisted.facts).toHaveLength(2);
    expect(persisted.facts[0]).toMatchObject({ code: '400', category: 'LINEHAUL', amount: '1000.0000', currency: 'USD' });
    expect(persisted.facts[1]).toMatchObject({ code: '405', category: 'FUEL', amount: '250.0000', currency: 'USD' });
  });

  it('AC3 e2e: valid 210 → SCORED audit_run + scorecard row', async () => {
    const inv = parse210(GOLDEN_210, testCategorize);
    const result = evaluateInvoice(inv);
    const row = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const p = await persistAuditRun(c, { clientId, invoice: inv, result, rubricSnapshotId: null });
      createdRunIds.push(p.auditRunId);
      const run = await c.query(`SELECT outcome FROM audit_run WHERE id = $1`, [p.auditRunId]);
      const sc = await c.query(
        `SELECT conformed_count, variance_count, unassessable_count FROM scorecard WHERE audit_run_id = $1`,
        [p.auditRunId],
      );
      const ledger = await c.query(`SELECT event, detail FROM audit_event WHERE entity_id = $1`, [p.auditRunId]);
      const manifest = await c.query(
        `SELECT schema_version, content_hash, manifest FROM audit_replay_manifest WHERE audit_run_id = $1`,
        [p.auditRunId],
      );
      return { outcome: run.rows[0].outcome, scorecard: sc.rows[0], ledger: ledger.rows[0], manifest: manifest.rows[0] };
    });
    expect(row.outcome).toBe('SCORED');
    expect(row.scorecard).toMatchObject({ conformed_count: 2, variance_count: 1 });
    expect(row.ledger).toMatchObject({
      event: 'evaluation.completed',
      detail: expect.objectContaining({ outcome: 'SCORED', scorecardId: expect.any(String) }),
    });
    expect(row.manifest).toMatchObject({
      schema_version: 1,
      content_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      manifest: expect.objectContaining({
        schemaVersion: 1,
        auditRunId: expect.any(String),
        externalValues: [],
        crosswalkRows: [],
        ai: [],
      }),
    });
  });

  it('AC2 e2e: malformed 210 → REJECTED_REWORK audit_run + gate_failure rows, NO scorecard', async () => {
    const inv = parse210(MALFORMED_210_NOFOOT, testCategorize);
    const result = evaluateInvoice(inv);
    const row = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const p = await persistAuditRun(c, { clientId, invoice: inv, result, rubricSnapshotId: null });
      createdRunIds.push(p.auditRunId);
      const run = await c.query(`SELECT outcome FROM audit_run WHERE id = $1`, [p.auditRunId]);
      const gf = await c.query(`SELECT defect, citation FROM gate_failure WHERE audit_run_id = $1`, [p.auditRunId]);
      const sc = await c.query(`SELECT count(*)::int AS n FROM scorecard WHERE audit_run_id = $1`, [p.auditRunId]);
      const cf = await c.query(`SELECT count(*)::int AS n FROM charge_finding WHERE audit_run_id = $1`, [p.auditRunId]);
      return { outcome: run.rows[0].outcome, gateFailures: gf.rows, scorecardCount: sc.rows[0].n, findingCount: cf.rows[0].n };
    });
    expect(row.outcome).toBe('REJECTED_REWORK');
    expect(row.gateFailures.length).toBeGreaterThanOrEqual(1);
    expect(row.gateFailures.every((g: { citation: string | null }) => g.citation)).toBe(true);
    expect(row.scorecardCount).toBe(0); // SCORE phase skipped
    expect(row.findingCount).toBe(0);
  });

  it('86e24cy5r fix: 310 with unstated currency → REJECTED_REWORK, NO charge_fact rows persisted', async () => {
    const inv = parse310(MALFORMED_310_NOCURRENCY, testCategorize);
    const result = evaluateInvoice(inv);
    expect(result.outcome).toBe('REJECTED_REWORK'); // sanity: this invoice does fail the currency gate
    const row = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const p = await persistAuditRun(c, { clientId, invoice: inv, result, rubricSnapshotId: null });
      createdRunIds.push(p.auditRunId);
      const facts = await c.query(`SELECT count(*)::int AS n FROM charge_fact WHERE invoice_id = $1`, [p.invoiceId]);
      const gf = await c.query(`SELECT defect FROM gate_failure WHERE audit_run_id = $1`, [p.auditRunId]);
      return { chargeFactCount: facts.rows[0].n, gateFailures: gf.rows };
    });
    // The bug: persist.ts used to write a 'XXX' sentinel charge_fact row here.
    // The fix: no charge_fact rows are written for a currency-gate rejection —
    // the gate_failure kickback is the canonical record instead.
    expect(row.chargeFactCount).toBe(0);
    expect(row.gateFailures.length).toBeGreaterThanOrEqual(1);
  });
});
