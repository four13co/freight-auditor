import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { parse210 } from '../../src/modules/ingestion/parse-210.js';
import { evaluateInvoice } from '../../src/modules/evaluator/evaluate-invoice.js';
import { persistAuditRun } from '../../src/modules/evaluator/persist.js';
import { GOLDEN_210, MALFORMED_210_NOFOOT, testCategorize } from '../fixtures/edi-golden.js';
import {
  generateShortPayDecision,
  GenerateShortPayError,
} from '../../src/modules/payments/generate-short-pay-decision.js';
import { ShortPayDecisionError } from '../../src/modules/payments/compose-short-pay-decision.js';

/**
 * P4.B.3: generates a short_pay payment_gate_decision (invoice total minus
 * accepted overcharge variance) for a SCORED audit run, opt-in via
 * shortPayEnabled. Mirrors generate-hold-decision.db.test.ts's shape.
 */
describe('generateShortPayDecision (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  const tag = `shortpay-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('SHORTPAY', $1) RETURNING id`, [tag]);
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
      await owner.query(`DELETE FROM variance_finding WHERE client_id = $1`, [clientId]);
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

  it('generates no decision when shortPayEnabled is omitted (opt-in default false)', async () => {
    const inv = parse210(GOLDEN_210, testCategorize);
    const result = evaluateInvoice(inv);

    const outcome = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const p = await persistAuditRun(c, { clientId, invoice: inv, result, rubricSnapshotId: null });
      return generateShortPayDecision(c, { clientId, auditRunId: p.auditRunId });
    });

    expect(outcome).toEqual({ decisionId: null, amountToPay: null, currency: null, findingIds: [], created: false });
  });

  it('rejects composing a short-pay decision with no accepted overcharge findings', async () => {
    const inv = parse210(GOLDEN_210, testCategorize);
    const result = evaluateInvoice(inv);
    expect(result.outcome).toBe('SCORED');

    await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const p = await persistAuditRun(c, { clientId, invoice: inv, result, rubricSnapshotId: null });
      await expect(generateShortPayDecision(c, { clientId, auditRunId: p.auditRunId, shortPayEnabled: true }))
        .rejects.toBeInstanceOf(ShortPayDecisionError);
    });
  });

  it('refuses to generate a short-pay decision for an audit run that did not reach SCORED', async () => {
    const inv = parse210(MALFORMED_210_NOFOOT, testCategorize);
    const result = evaluateInvoice(inv);
    expect(result.outcome).toBe('REJECTED_REWORK');

    await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const p = await persistAuditRun(c, { clientId, invoice: inv, result, rubricSnapshotId: null });
      await expect(generateShortPayDecision(c, { clientId, auditRunId: p.auditRunId, shortPayEnabled: true }))
        .rejects.toBeInstanceOf(GenerateShortPayError);
    });
  });

  it('fails closed for an unknown audit_run_id', async () => {
    await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      await expect(
        generateShortPayDecision(c, {
          clientId,
          auditRunId: '00000000-0000-0000-0000-000000000000',
          shortPayEnabled: true,
        }),
      ).rejects.toBeInstanceOf(GenerateShortPayError);
    });
  });

  it('generates a short-pay decision withholding an accepted overcharge finding, idempotently', async () => {
    const inv = parse210(GOLDEN_210, testCategorize);
    const result = evaluateInvoice(inv);
    expect(result.outcome).toBe('SCORED');

    const row = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const p = await persistAuditRun(c, { clientId, invoice: inv, result, rubricSnapshotId: null });

      const chargeTotal = await c.query<{ sum: string }>(
        `SELECT SUM(amount)::text AS sum FROM charge_fact WHERE client_id = $1 AND invoice_id = $2`,
        [clientId, p.invoiceId],
      );
      const invoiceTotal = chargeTotal.rows[0]!.sum;

      const findingResult = await c.query<{ id: string }>(
        `INSERT INTO variance_finding
           (client_id, audit_run_id, charge_fact_id, direction, variance_amount, currency, status, evaluated_expr)
         SELECT $1, $2, cf.id, 'OVERCHARGE', '10.0000', 'USD', 'accepted', '{}'::jsonb
           FROM charge_fact cf WHERE cf.client_id = $1 AND cf.invoice_id = $3 LIMIT 1
         RETURNING id`,
        [clientId, p.auditRunId, p.invoiceId],
      );
      const findingId = findingResult.rows[0]!.id;

      const first = await generateShortPayDecision(c, { clientId, auditRunId: p.auditRunId, shortPayEnabled: true });
      const retry = await generateShortPayDecision(c, { clientId, auditRunId: p.auditRunId, shortPayEnabled: true });
      const decisions = await c.query(
        `SELECT action, actor_kind, amount, currency FROM payment_gate_decision WHERE client_id = $1 AND audit_run_id = $2`,
        [clientId, p.auditRunId],
      );
      return { first, retry, decisions: decisions.rows, invoiceTotal, findingId };
    });

    expect(row.decisions).toHaveLength(1);
    expect(row.decisions[0]).toMatchObject({ action: 'short_pay', actor_kind: 'system', currency: 'USD' });
    expect(row.first.created).toBe(true);
    expect(row.first.findingIds).toEqual([row.findingId]);
    expect(row.retry.created).toBe(false);
    expect(row.retry.decisionId).toBe(row.first.decisionId);
  });
});
