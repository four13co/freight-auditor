import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { parse210 } from '../../src/modules/ingestion/parse-210.js';
import { evaluateInvoice } from '../../src/modules/evaluator/evaluate-invoice.js';
import { persistAuditRun } from '../../src/modules/evaluator/persist.js';
import { listGateFailures } from '../../src/modules/findings/list-gate-failures.js';
import { listFindings } from '../../src/modules/findings/list-findings.js';
import { MALFORMED_210_BADAMOUNT, MALFORMED_210_NOFOOT, GOLDEN_310, testCategorize } from '../fixtures/edi-golden.js';
import { parse310 } from '../../src/modules/ingestion/parse-310.js';

/**
 * 86e2v17xn: listGateFailures' backing query. Covers the real pipeline
 * (parse210 -> evaluateInvoice -> persistAuditRun) producing gate_failure
 * rows for a REJECTED_REWORK run, multi-gate-failure COLLECT_ALL retrieval,
 * RLS isolation, and structural separation from listFindings.
 */
describe('listGateFailures (DB)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let clientBId: string;
  const tag = `lgf-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('LGF-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const b = await owner.query(`INSERT INTO client (name, slug) VALUES ('LGF-B', $1) RETURNING id`, [`${tag}-b`]);
      clientBId = b.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM audit_replay_manifest WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM variance_finding WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM scorecard WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM charge_finding WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM gate_failure WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM audit_run WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM charge_fact WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM invoice WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM client WHERE id IN ($1, $2)`, [clientAId, clientBId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  /** Runs the real pipeline for a client, returns { auditRunId, outcome }. */
  async function runPipeline(client: pg.PoolClient, forClientId: string, rawEdi: string) {
    const inv = parse210(rawEdi, testCategorize);
    const result = evaluateInvoice(inv);
    const persisted = await persistAuditRun(client, { clientId: forClientId, invoice: inv, result, rubricSnapshotId: null });
    return { auditRunId: persisted.auditRunId, outcome: result.outcome };
  }

  it('AC1: a STD.FOOTING gate failure is retrievable with its defect and citation text', async () => {
    const rows = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const { outcome } = await runPipeline(c, clientAId, MALFORMED_210_NOFOOT);
      expect(outcome).toBe('REJECTED_REWORK');
      return listGateFailures(c, { clientIds: [clientAId] });
    });

    // Scoped to this test's own invoice, not a global count -- internal:
    // true grants cross-client visibility, so asserting rows.length here
    // instead would break on any sibling gate_failure data (another test's
    // leftover run, concurrent test data) that has nothing to do with this
    // assertion.
    const ownRows = rows.filter((r) => r.invoiceNumber === 'INV210003');
    expect(ownRows).toHaveLength(1);
    expect(ownRows[0]).toMatchObject({
      invoiceNumber: 'INV210003',
      defect: expect.stringContaining('foots'),
      citation: expect.stringContaining('B3-07'),
    });
    expect(typeof ownRows[0]?.recordedAt).toBe('object'); // Date, via pg
  });

  it('AC2: a run failing multiple gate criteria at once surfaces ALL gate_failure rows, not just one (COLLECT_ALL)', async () => {
    const rows = await withTenantTx({ clientIds: [clientAId], internal: true }, async (c) => {
      const { outcome } = await runPipeline(c, clientAId, MALFORMED_210_BADAMOUNT);
      expect(outcome).toBe('REJECTED_REWORK');
      return listGateFailures(c, { clientIds: [clientAId] });
    });

    // MALFORMED_210_BADAMOUNT fails BOTH STD.FOOTING (the unparseable charge
    // drops out of the line sum, breaking footing) AND STD.AMOUNT_STATED (the
    // charge itself is unparseable) -- verified empirically before writing
    // this test, not assumed.
    const defects = rows.map((r) => r.defect);
    expect(defects.some((d) => d.includes('foots'))).toBe(true);
    expect(defects.some((d) => d.toLowerCase().includes('parseable'))).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('AC3: a rejected invoice appears ONLY via listGateFailures, and a scored variance appears ONLY via listFindings', async () => {
    const { gateFailureRows, findingRows } = await withTenantTx(
      { clientIds: [clientAId], internal: true },
      async (c) => {
        await runPipeline(c, clientAId, MALFORMED_210_NOFOOT); // REJECTED_REWORK
        const scoredInv = parse310(GOLDEN_310, testCategorize); // SCORED, CONFORMED (no variance, but still SCORED)
        const scoredResult = evaluateInvoice(scoredInv);
        await persistAuditRun(c, { clientId: clientAId, invoice: scoredInv, result: scoredResult, rubricSnapshotId: null });

        return {
          gateFailureRows: await listGateFailures(c, { clientIds: [clientAId] }),
          findingRows: await listFindings(c, { clientIds: [clientAId] }),
        };
      },
    );

    expect(gateFailureRows.some((r) => r.invoiceNumber === 'INV210003')).toBe(true);
    expect(gateFailureRows.every((r) => r.invoiceNumber !== 'INV310002')).toBe(true);
    // GOLDEN_310 conforms cleanly -- no variance_finding rows exist for it,
    // so this only proves the rejected invoice never leaks into listFindings,
    // not that a variance row for the scored one exists (none is expected).
    expect(findingRows.every((r) => r.invoiceNumber !== 'INV210003')).toBe(true);
  });

  it('AC2 (RLS isolation): client B never sees client A gate_failure rows', async () => {
    await withTenantTx({ clientIds: [clientAId], internal: true }, (c) => runPipeline(c, clientAId, MALFORMED_210_NOFOOT));

    const bRows = await withTenantTx({ clientIds: [clientBId], internal: false }, (c) =>
      listGateFailures(c, { clientIds: [clientBId] }),
    );
    expect(bRows).toHaveLength(0);
  });
});
