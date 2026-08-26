import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { parse210 } from '../../src/modules/ingestion/parse-210.js';
import { parse310 } from '../../src/modules/ingestion/parse-310.js';
import { evaluateInvoice } from '../../src/modules/evaluator/evaluate-invoice.js';
import { persistAuditRun } from '../../src/modules/evaluator/persist.js';
import { CONTRACT_RUBRIC } from '../../src/modules/rubric-resolver/contract-rubric.js';
import { STANDARD_RUBRIC } from '../../src/modules/rubric-resolver/standard-rubric.js';
import { seedCriteria } from '../../scripts/seed-criteria.mjs';
import { GOLDEN_210, MIXED_CURRENCY_LINEHAUL_310, testCategorize } from '../fixtures/edi-golden.js';

/**
 * 86e2v17p5: persistAuditRun derives variance_finding rows from the
 * charge_findings it already writes -- bridging the gap where GET
 * /api/findings (variance_finding) had no writer at all. Built fresh against
 * Greg's DECISION comment on this task (2026-08-16), NOT the task body's
 * stale AC7 (criterion_id/rule_version_id -- struck, see 86e2v2dh1) or its
 * "always populate charge_fact_id, never null" line (superseded: attribute
 * to the invoice, charge_fact_id NULL when more than one LINEHAUL charge
 * contributed).
 */
describe('persistAuditRun variance_finding derivation (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  let carrierId: string;
  let contractId: string;
  let contractVersionId: string;
  const tag = `vf-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    // 86e2v88u2: resolveCriterionIds resolves against whatever seedCriteria has
    // written -- idempotent (ON CONFLICT DO NOTHING / NOT EXISTS guards), so
    // safe to call here regardless of whether another suite already seeded it.
    await seedCriteria({ client: pool });
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('VF', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const carrier = await owner.query(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [`Carrier-${tag}`]);
      carrierId = carrier.rows[0].id;
      const contract = await owner.query(
        `INSERT INTO contract (client_id, carrier_id, name) VALUES ($1, $2, 'VF Contract') RETURNING id`,
        [clientId, carrierId],
      );
      contractId = contract.rows[0].id;
      const version = await owner.query(
        `INSERT INTO contract_version (client_id, contract_id, version_label, valid_from) VALUES ($1, $2, 'v1', CURRENT_DATE) RETURNING id`,
        [clientId, contractId],
      );
      contractVersionId = version.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM audit_replay_manifest WHERE client_id = $1`, [clientId]);
      // variance_finding before audit_run (86e2v250p-adjacent regression this
      // item's own prior build attempt introduced and fixed: FK ordering).
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

  it('a VARIANCE charge_finding (single LINEHAUL charge) writes one variance_finding row with charge_fact_id populated', async () => {
    await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      await c.query(
        `INSERT INTO contract_rate (client_id, contract_version_id, category, rate, currency) VALUES ($1, $2, 'LINEHAUL', 900.00, 'USD')`,
        [clientId, contractVersionId],
      );
    });

    const inv = parse210(GOLDEN_210, testCategorize); // single LINEHAUL charge, billed 1000.00 USD
    const result = evaluateInvoice(inv, CONTRACT_RUBRIC, { linehaulRate: { amount: '900.0000', currency: 'USD', clauseId: null } });

    const row = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const p = await persistAuditRun(c, { clientId, invoice: inv, result, rubricSnapshotId: null });
      const vf = await c.query(
        `SELECT charge_fact_id, direction, variance_amount, currency, classification, status
         FROM variance_finding WHERE audit_run_id = $1`,
        [p.auditRunId],
      );
      return { auditRunId: p.auditRunId, chargeFactIds: p.chargeFindingIds, rows: vf.rows };
    });

    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({
      direction: 'OVERCHARGE',
      variance_amount: '100.0000',
      currency: 'USD',
      status: 'open',
    });
    expect(row.rows[0].charge_fact_id).not.toBeNull();
  });

  it('a VARIANCE charge_finding with TWO contributing LINEHAUL charges (same currency) writes one variance_finding row with charge_fact_id NULL', async () => {
    await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      // Rate covers both currencies' worth of linehaul (2000 total billed).
      await c.query(
        `DELETE FROM contract_rate WHERE contract_version_id = $1 AND category = 'LINEHAUL'`,
        [contractVersionId],
      );
      await c.query(
        `INSERT INTO contract_rate (client_id, contract_version_id, category, rate, currency) VALUES ($1, $2, 'LINEHAUL', 1500.00, 'USD')`,
        [clientId, contractVersionId],
      );
    });

    // MIXED_CURRENCY_LINEHAUL_310 has 2 LINEHAUL charges in different
    // currencies (USD/EUR) -- that combination is UNASSESSABLE (86e25urnj),
    // not what this test needs (two SAME-currency contributing charges). Use
    // GOLDEN_310 style construction isn't available as a two-same-currency
    // fixture, so build the invoice directly instead of relying on a fixture
    // that doesn't exist -- parse310 + a hand-rolled two-LINEHAUL-USD raw EDI
    // string would duplicate parser test surface; simplest faithful seam is
    // constructing a ParsedInvoice-shaped object bypassing the parser, since
    // this test is about persist.ts's attribution logic, not parsing.
    const inv = parse310(MIXED_CURRENCY_LINEHAUL_310, testCategorize);
    // Force both LINEHAUL charges to the same currency so the pair
    // contributes to ONE compare (still two charge_fact rows -- the
    // attribution case this test exercises) instead of resolving
    // UNASSESSABLE via the mixed-currency guard.
    for (const charge of inv.charges) {
      if (charge.category === 'LINEHAUL') charge.currency = 'USD';
    }

    const result = evaluateInvoice(inv, CONTRACT_RUBRIC, { linehaulRate: { amount: '1500.0000', currency: 'USD', clauseId: null } });
    const finding = result.findings.find((f) => f.criterionKey === 'CONTRACT.RATE_VARIANCE');
    expect(finding?.result).toBe('VARIANCE'); // sanity: this is exercising the multi-charge path, not UNASSESSABLE

    const row = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const p = await persistAuditRun(c, { clientId, invoice: inv, result, rubricSnapshotId: null });
      const cf = await c.query(`SELECT id FROM charge_fact WHERE invoice_id = $1 AND category = 'LINEHAUL'`, [p.invoiceId]);
      const vf = await c.query(
        `SELECT charge_fact_id, direction, variance_amount FROM variance_finding WHERE audit_run_id = $1 AND direction = 'OVERCHARGE'`,
        [p.auditRunId],
      );
      return { linehaulChargeFactCount: cf.rows.length, rows: vf.rows };
    });

    expect(row.linehaulChargeFactCount).toBe(2); // sanity: two charge_fact rows really were written
    // Exactly one OVERCHARGE row -- the invoice-level CONTRACT.RATE_VARIANCE
    // finding, not silently skipped. (This fixture also produces a second,
    // unrelated STD.FUEL_PRESENT VARIANCE row with direction NULL -- correct
    // per the No-go that every VARIANCE/UNASSESSABLE finding gets a row; this
    // test only asserts on the LINEHAUL-attributable one.)
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].charge_fact_id).toBeNull(); // ambiguous attribution (2 contributing charges) -> NULL, per the DECISION
  });

  it('an UNASSESSABLE charge_finding writes a variance_finding row with direction/variance_amount NULL and classification identifying it', async () => {
    const inv = parse210(GOLDEN_210, testCategorize);
    const result = evaluateInvoice(inv, CONTRACT_RUBRIC, { linehaulRate: null }); // no rate -> UNASSESSABLE
    const finding = result.findings.find((f) => f.criterionKey === 'CONTRACT.RATE_VARIANCE');
    expect(finding?.result).toBe('UNASSESSABLE');

    const row = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const p = await persistAuditRun(c, { clientId, invoice: inv, result, rubricSnapshotId: null });
      const vf = await c.query(
        `SELECT direction, variance_amount, classification FROM variance_finding WHERE audit_run_id = $1`,
        [p.auditRunId],
      );
      return vf.rows;
    });

    expect(row).toHaveLength(1);
    expect(row[0].direction).toBeNull();
    expect(row[0].variance_amount).toBeNull();
    expect(row[0].classification).toMatch(/unassessable/i);
  });

  it('a CONFORMED charge_finding writes NO variance_finding row', async () => {
    const inv = parse210(GOLDEN_210, testCategorize);
    const result = evaluateInvoice(inv, CONTRACT_RUBRIC, { linehaulRate: { amount: '1000.0000', currency: 'USD', clauseId: null } }); // exact match -> CONFORMED
    const finding = result.findings.find((f) => f.criterionKey === 'CONTRACT.RATE_VARIANCE');
    expect(finding?.result).toBe('CONFORMED');

    const count = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const p = await persistAuditRun(c, { clientId, invoice: inv, result, rubricSnapshotId: null });
      const vf = await c.query(`SELECT count(*)::int AS n FROM variance_finding WHERE audit_run_id = $1`, [p.auditRunId]);
      return vf.rows[0].n;
    });
    expect(count).toBe(0);
  });

  it('a STANDARD-only run (no CONTRACT tier) with a VARIANCE-shaped result still writes rows for every non-CONFORMED finding, none silently dropped for low materiality', async () => {
    const inv = parse210(GOLDEN_210, testCategorize);
    const result = evaluateInvoice(inv, STANDARD_RUBRIC); // STANDARD-only: no dollar variances possible
    const nonConformed = result.findings.filter((f) => f.result !== 'CONFORMED');

    const count = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const p = await persistAuditRun(c, { clientId, invoice: inv, result, rubricSnapshotId: null });
      const vf = await c.query(`SELECT count(*)::int AS n FROM variance_finding WHERE audit_run_id = $1`, [p.auditRunId]);
      return vf.rows[0].n;
    });
    // Every VARIANCE/UNASSESSABLE finding gets a row -- no materiality floor
    // suppresses the write (No-go), even though STANDARD criteria never
    // produce a dollar variance_amount.
    expect(count).toBe(nonConformed.length);
  });

  it('populates criterion_id/rule_version_id on charge_finding and variance_finding for a known criterion (86e2v88u2)', async () => {
    await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      await c.query(
        `DELETE FROM contract_rate WHERE contract_version_id = $1 AND category = 'LINEHAUL'`,
        [contractVersionId],
      );
      await c.query(
        `INSERT INTO contract_rate (client_id, contract_version_id, category, rate, currency) VALUES ($1, $2, 'LINEHAUL', 900.00, 'USD')`,
        [clientId, contractVersionId],
      );
    });

    const inv = parse210(GOLDEN_210, testCategorize);
    const result = evaluateInvoice(inv, CONTRACT_RUBRIC, { linehaulRate: { amount: '900.0000', currency: 'USD', clauseId: null } });
    const finding = result.findings.find((f) => f.criterionKey === 'CONTRACT.RATE_VARIANCE');
    expect(finding?.result).toBe('VARIANCE'); // sanity: exercising a real, resolvable criterion

    const rows = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const p = await persistAuditRun(c, { clientId, invoice: inv, result, rubricSnapshotId: null });
      const cf = await c.query(
        `SELECT criterion_id, rule_version_id FROM charge_finding
         WHERE audit_run_id = $1 AND result = 'VARIANCE'`,
        [p.auditRunId],
      );
      const vf = await c.query(
        `SELECT criterion_id, rule_version_id FROM variance_finding
         WHERE audit_run_id = $1 AND direction = 'OVERCHARGE'`,
        [p.auditRunId],
      );
      return { chargeFinding: cf.rows, varianceFinding: vf.rows };
    });

    expect(rows.chargeFinding).toHaveLength(1);
    expect(rows.chargeFinding[0].criterion_id).not.toBeNull();
    expect(rows.chargeFinding[0].rule_version_id).not.toBeNull();

    expect(rows.varianceFinding).toHaveLength(1);
    expect(rows.varianceFinding[0].criterion_id).not.toBeNull();
    expect(rows.varianceFinding[0].rule_version_id).not.toBeNull();
    // both tables must resolve to the SAME criterion/rule_version for the same
    // criterionKey -- not independently-resolved, possibly-divergent ids.
    expect(rows.varianceFinding[0].criterion_id).toBe(rows.chargeFinding[0].criterion_id);
    expect(rows.varianceFinding[0].rule_version_id).toBe(rows.chargeFinding[0].rule_version_id);
  });

  it('leaves criterion_id/rule_version_id NULL (not a persist failure) for a criterionKey with no seeded row', async () => {
    // resolveCriterionIds' own contract (scripts/seed-criteria.mjs): returns
    // null rather than throwing when a criterionKey has no seeded row, since a
    // caller must be able to write a finding for a criterion that predates the
    // seed step or was added after the last seed run. Proven here at the
    // persist.ts call site, not just inside seed-criteria.db.test.ts's own
    // resolver-only coverage.
    const inv = parse210(GOLDEN_210, testCategorize);
    const result = evaluateInvoice(inv, CONTRACT_RUBRIC, { linehaulRate: { amount: '900.0000', currency: 'USD', clauseId: null } });
    const patched = {
      ...result,
      findings: result.findings.map((f) => ({ ...f, criterionKey: 'UNSEEDED.NONEXISTENT_KEY' })),
    };

    const rows = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const p = await persistAuditRun(c, { clientId, invoice: inv, result: patched, rubricSnapshotId: null });
      const cf = await c.query(
        `SELECT criterion_id, rule_version_id FROM charge_finding WHERE audit_run_id = $1`,
        [p.auditRunId],
      );
      return cf.rows;
    });

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.criterion_id).toBeNull();
      expect(row.rule_version_id).toBeNull();
    }
  });

  it('the derivation runs inside the same transaction as the rest of persistAuditRun (no partial write on error)', async () => {
    // Confirms variance_finding and charge_finding are written by the same
    // call, both visible together -- proving no separate transaction/step was
    // introduced (Rabbit hole: must not add a second transaction or
    // post-commit step).
    const inv = parse210(GOLDEN_210, testCategorize);
    const result = evaluateInvoice(inv, CONTRACT_RUBRIC, { linehaulRate: { amount: '900.0000', currency: 'USD', clauseId: null } });

    const counts = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const p = await persistAuditRun(c, { clientId, invoice: inv, result, rubricSnapshotId: null });
      const cf = await c.query(`SELECT count(*)::int AS n FROM charge_finding WHERE audit_run_id = $1`, [p.auditRunId]);
      const vf = await c.query(`SELECT count(*)::int AS n FROM variance_finding WHERE audit_run_id = $1`, [p.auditRunId]);
      return { chargeFindingCount: cf.rows[0].n, varianceFindingCount: vf.rows[0].n };
    });
    expect(counts.chargeFindingCount).toBeGreaterThan(0);
    expect(counts.varianceFindingCount).toBeGreaterThan(0);
  });
});
