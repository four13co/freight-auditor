import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { parse210 } from '../../src/modules/ingestion/parse-210.js';
import { evaluateInvoice } from '../../src/modules/evaluator/evaluate-invoice.js';
import { persistAuditRun } from '../../src/modules/evaluator/persist.js';
import { GOLDEN_210, MALFORMED_210_NOFOOT, testCategorize } from '../fixtures/edi-golden.js';
import {
  generateHoldDecision,
  GenerateHoldDecisionError,
} from '../../src/modules/payments/generate-hold-decision.js';

/**
 * P4.B.2: generates a default 'hold' payment_gate_decision for an audit run
 * that reached SCORED, mirroring generate-do-not-pay-decision.db.test.ts's
 * shape for the opposite outcome.
 */
describe('generateHoldDecision (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  const tag = `hold-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('HOLD', $1) RETURNING id`, [tag]);
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

  it('generates one hold decision for a SCORED audit run, idempotently, defaulting holdThenApprove to true', async () => {
    const inv = parse210(GOLDEN_210, testCategorize);
    const result = evaluateInvoice(inv);
    expect(result.outcome).toBe('SCORED');

    const row = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const p = await persistAuditRun(c, { clientId, invoice: inv, result, rubricSnapshotId: null });
      const first = await generateHoldDecision(c, { clientId, auditRunId: p.auditRunId });
      const retry = await generateHoldDecision(c, { clientId, auditRunId: p.auditRunId });
      const decisions = await c.query(
        `SELECT action, actor_kind, amount, currency FROM payment_gate_decision WHERE client_id = $1 AND audit_run_id = $2`,
        [clientId, p.auditRunId],
      );
      return { first, retry, decisions: decisions.rows };
    });

    expect(row.decisions).toHaveLength(1);
    expect(row.decisions[0]).toMatchObject({ action: 'hold', actor_kind: 'system', amount: null, currency: null });
    expect(row.first.created).toBe(true);
    expect(row.retry.created).toBe(false);
    expect(row.retry.decisionId).toBe(row.first.decisionId);
  });

  it('generates no decision when holdThenApprove is explicitly false', async () => {
    const inv = parse210(GOLDEN_210, testCategorize);
    const result = evaluateInvoice(inv);

    const row = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const p = await persistAuditRun(c, { clientId, invoice: inv, result, rubricSnapshotId: null });
      const outcome = await generateHoldDecision(c, { clientId, auditRunId: p.auditRunId, holdThenApprove: false });
      const decisions = await c.query(
        `SELECT action FROM payment_gate_decision WHERE client_id = $1 AND audit_run_id = $2`,
        [clientId, p.auditRunId],
      );
      return { outcome, decisions: decisions.rows };
    });

    expect(row.outcome).toEqual({ decisionId: null, created: false });
    expect(row.decisions).toHaveLength(0);
  });

  it('refuses to generate a hold decision for an audit run that did not reach SCORED', async () => {
    const inv = parse210(MALFORMED_210_NOFOOT, testCategorize);
    const result = evaluateInvoice(inv);
    expect(result.outcome).toBe('REJECTED_REWORK');

    await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const p = await persistAuditRun(c, { clientId, invoice: inv, result, rubricSnapshotId: null });
      await expect(generateHoldDecision(c, { clientId, auditRunId: p.auditRunId }))
        .rejects.toBeInstanceOf(GenerateHoldDecisionError);
    });
  });

  it('fails closed for an unknown audit_run_id', async () => {
    await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      await expect(
        generateHoldDecision(c, { clientId, auditRunId: '00000000-0000-0000-0000-000000000000' }),
      ).rejects.toBeInstanceOf(GenerateHoldDecisionError);
    });
  });
});
