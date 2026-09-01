import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { parse210 } from '../../src/modules/ingestion/parse-210.js';
import { evaluateInvoice } from '../../src/modules/evaluator/evaluate-invoice.js';
import { persistAuditRun } from '../../src/modules/evaluator/persist.js';
import { GOLDEN_210, testCategorize } from '../fixtures/edi-golden.js';
import {
  generatePaymentEscalation,
  GeneratePaymentEscalationError,
} from '../../src/modules/payments/generate-payment-escalation.js';

/**
 * P4.B.7: records a payment_gate.escalated audit event for a SCORED audit
 * run whose default 'hold' decision remains un-approved past a grace
 * period. Never mutates the hold row or writes an 'approve' row --
 * payment_gate_decision is append-only-granted (SELECT+INSERT only,
 * migration 0010), so there is no path to do either even by mistake.
 */
describe('generatePaymentEscalation (DB)', () => {
  let pool: pg.Pool;
  let clientId: string;
  const tag = `esc-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('ESC', $1) RETURNING id`, [tag]);
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
      await owner.query(`DELETE FROM finding_status_event WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM variance_finding WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM scorecard WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM gate_failure WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM charge_finding WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM audit_run WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM charge_fact WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM invoice WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  async function seedScoredRun(c: pg.PoolClient): Promise<string> {
    const inv = parse210(GOLDEN_210, testCategorize);
    const result = evaluateInvoice(inv);
    const p = await persistAuditRun(c, { clientId, invoice: inv, result, rubricSnapshotId: null });
    return p.auditRunId;
  }

  async function insertHold(c: pg.PoolClient, auditRunId: string, recordedAt: string): Promise<void> {
    const run = await c.query<{ invoice_id: string }>(`SELECT invoice_id FROM audit_run WHERE id = $1`, [auditRunId]);
    await c.query(
      `INSERT INTO payment_gate_decision (client_id, invoice_id, audit_run_id, action, actor_kind, rationale, recorded_at)
       VALUES ($1,$2,$3,'hold','system','Held by default.',$4::timestamptz)`,
      [clientId, run.rows[0]!.invoice_id, auditRunId, recordedAt],
    );
  }

  it('escalates a hold that has aged past the grace period, idempotently', async () => {
    const row = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const auditRunId = await seedScoredRun(c);
      await insertHold(c, auditRunId, '2026-08-01T00:00:00.000Z');

      const first = await generatePaymentEscalation(c, clientId, auditRunId, new Date('2026-08-10T00:00:00.000Z'));
      const retry = await generatePaymentEscalation(c, clientId, auditRunId, new Date('2026-08-10T00:00:00.000Z'));

      const holdRows = await c.query(
        `SELECT action FROM payment_gate_decision WHERE client_id = $1 AND audit_run_id = $2`,
        [clientId, auditRunId],
      );
      return { first, retry, holdRows: holdRows.rows };
    });

    expect(row.first.created).toBe(true);
    expect(row.retry.created).toBe(false);
    expect(row.retry.auditEventId).toBe(row.first.auditEventId);
    // The hold row is untouched: still exactly one decision, still 'hold', no 'approve' ever appeared.
    expect(row.holdRows).toEqual([{ action: 'hold' }]);
  });

  it('refuses to escalate when the grace period has not elapsed', async () => {
    await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const auditRunId = await seedScoredRun(c);
      await insertHold(c, auditRunId, '2026-08-01T00:00:00.000Z');
      await expect(generatePaymentEscalation(c, clientId, auditRunId, new Date('2026-08-02T00:00:00.000Z')))
        .rejects.toBeInstanceOf(GeneratePaymentEscalationError);
    });
  });

  it('refuses to escalate once an approve decision exists for the run', async () => {
    await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const auditRunId = await seedScoredRun(c);
      await insertHold(c, auditRunId, '2026-08-01T00:00:00.000Z');
      const run = await c.query<{ invoice_id: string }>(`SELECT invoice_id FROM audit_run WHERE id = $1`, [auditRunId]);
      await c.query(
        `INSERT INTO payment_gate_decision (client_id, invoice_id, audit_run_id, action, actor_kind, rationale)
         VALUES ($1,$2,$3,'approve','analyst','Approved by analyst.')`,
        [clientId, run.rows[0]!.invoice_id, auditRunId],
      );

      await expect(generatePaymentEscalation(c, clientId, auditRunId, new Date('2026-08-20T00:00:00.000Z')))
        .rejects.toMatchObject({ code: 'ALREADY_APPROVED' });
    });
  });

  it('fails closed when no hold decision exists for the run', async () => {
    await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const auditRunId = await seedScoredRun(c);
      await expect(generatePaymentEscalation(c, clientId, auditRunId, new Date('2026-08-20T00:00:00.000Z')))
        .rejects.toMatchObject({ code: 'NO_HOLD_DECISION' });
    });
  });
});
