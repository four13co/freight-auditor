import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { parse210 } from '../../src/modules/ingestion/parse-210.js';
import { evaluateInvoice } from '../../src/modules/evaluator/evaluate-invoice.js';
import { persistAuditRun } from '../../src/modules/evaluator/persist.js';
import { GOLDEN_210, MALFORMED_210_NOFOOT, testCategorize } from '../fixtures/edi-golden.js';
import {
  generateDoNotPayDecision,
  GenerateDoNotPayError,
} from '../../src/modules/payments/generate-do-not-pay-decision.js';

/**
 * P4.B.4: generates a do_not_pay payment_gate_decision from an audit run's
 * gate failures. Reuses the real gate-rejection pipeline (persistAuditRun
 * against MALFORMED_210_NOFOOT) rather than hand-inserting gate_failure rows,
 * so the seed matches production shape exactly.
 */
describe('generateDoNotPayDecision (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  const tag = `dnp-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('DNP', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM payment_gate_decision WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM audit_replay_manifest WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM gate_failure WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM charge_finding WHERE client_id = $1`, [clientId]);
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

  it('generates one do_not_pay decision with a composed rationale from all gate failures, idempotently', async () => {
    const inv = parse210(MALFORMED_210_NOFOOT, testCategorize);
    const result = evaluateInvoice(inv);
    expect(result.outcome).toBe('REJECTED_REWORK');

    const row = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const p = await persistAuditRun(c, { clientId, invoice: inv, result, rubricSnapshotId: null });
      const first = await generateDoNotPayDecision(c, { clientId, auditRunId: p.auditRunId });
      const retry = await generateDoNotPayDecision(c, { clientId, auditRunId: p.auditRunId });
      const decisions = await c.query(
        `SELECT action, actor_kind, amount, currency, rationale FROM payment_gate_decision WHERE client_id = $1 AND audit_run_id = $2`,
        [clientId, p.auditRunId],
      );
      return { first, retry, decisions: decisions.rows };
    });

    expect(row.decisions).toHaveLength(1);
    expect(row.decisions[0]).toMatchObject({ action: 'do_not_pay', actor_kind: 'system', amount: null, currency: null });
    expect(row.decisions[0].rationale).toBe(row.first.rationale);
    expect(row.retry).toEqual(row.first);
  });

  it('refuses to generate a decision for an audit run that reached SCORED', async () => {
    const inv = parse210(GOLDEN_210, testCategorize);
    const result = evaluateInvoice(inv);
    expect(result.outcome).toBe('SCORED');

    await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const p = await persistAuditRun(c, { clientId, invoice: inv, result, rubricSnapshotId: null });
      await expect(generateDoNotPayDecision(c, { clientId, auditRunId: p.auditRunId }))
        .rejects.toBeInstanceOf(GenerateDoNotPayError);
    });
  });

  it('fails closed for an unknown audit_run_id', async () => {
    await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      await expect(
        generateDoNotPayDecision(c, { clientId, auditRunId: '00000000-0000-0000-0000-000000000000' }),
      ).rejects.toBeInstanceOf(GenerateDoNotPayError);
    });
  });
});
