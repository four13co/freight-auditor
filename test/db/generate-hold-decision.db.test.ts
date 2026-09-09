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
import { cleanupTenantFixtures } from './helpers/cleanup-tenant-fixtures.js';

/**
 * P4.B.2: generates a default 'hold' payment_gate_decision for an audit run
 * that reached SCORED, mirroring generate-do-not-pay-decision.db.test.ts's
 * shape for the opposite outcome.
 *
 * Teardown goes through cleanupTenantFixtures (86e30txkx), which derives a
 * FK-safe delete order from the live schema instead of a hand-maintained
 * list -- this file's own hand-ordered list was this item's prior
 * review-closure defect (23503 on audit_run's FK), the same class as #195's
 * fix for generate-do-not-pay-decision.db.test.ts.
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
    await cleanupTenantFixtures(pool, [clientId]);
    // app_user has no client_id column, so cleanupTenantFixtures' generic
    // scope doesn't reach the configurer seeded for the opt-out test below --
    // must run after (client_payment_policy.configured_by FKs into it).
    await pool.query(`DELETE FROM app_user WHERE email = $1`, [`${tag}-configurer@example.com`]);
    await closePool();
  });

  // 86e367r9x: persistAuditRun now wires generateHoldDecision internally for
  // any SCORED run (the platform hold-then-approve default, no
  // client_payment_policy row configured for this test's fresh client) --
  // so a subsequent explicit call is necessarily a no-op retry, not a fresh
  // create. This test proves that wiring; the next one proves
  // generateHoldDecision's own fresh-create behavior in isolation (the
  // original AC this file existed to prove, before persistAuditRun called it
  // for us).
  it('persistAuditRun wires exactly one hold decision for a SCORED run, and an explicit call on top of it is idempotent', async () => {
    const inv = parse210(GOLDEN_210, testCategorize);
    const result = evaluateInvoice(inv);
    expect(result.outcome).toBe('SCORED');

    const row = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const p = await persistAuditRun(c, { clientId, invoice: inv, result, rubricSnapshotId: null });
      const retry = await generateHoldDecision(c, { clientId, auditRunId: p.auditRunId });
      const decisions = await c.query(
        `SELECT action, actor_kind, amount, currency FROM payment_gate_decision WHERE client_id = $1 AND audit_run_id = $2`,
        [clientId, p.auditRunId],
      );
      return { retry, decisions: decisions.rows };
    });

    expect(row.decisions).toHaveLength(1);
    expect(row.decisions[0]).toMatchObject({ action: 'hold', actor_kind: 'system', amount: null, currency: null });
    expect(row.retry.created).toBe(false);
  });

  it('generateHoldDecision itself creates a fresh hold decision, idempotently, when called directly against a SCORED run', async () => {
    // Seeds audit_run directly via raw SQL rather than persistAuditRun, so
    // this proves generateHoldDecision's OWN create-then-idempotent-retry
    // behavior, independent of persist.ts's automatic wiring above.
    const owner = await pool.connect();
    let auditRunId: string;
    try {
      const invoice = await owner.query<{ id: string }>(
        `INSERT INTO invoice (client_id, transaction_set, parser_version) VALUES ($1, '210', 'test') RETURNING id`,
        [clientId],
      );
      const run = await owner.query<{ id: string }>(
        `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'test', 'SCORED') RETURNING id`,
        [clientId, invoice.rows[0]!.id],
      );
      auditRunId = run.rows[0]!.id;
    } finally {
      owner.release();
    }

    const row = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const first = await generateHoldDecision(c, { clientId, auditRunId });
      const retry = await generateHoldDecision(c, { clientId, auditRunId });
      return { first, retry };
    });

    expect(row.first.created).toBe(true);
    expect(row.retry.created).toBe(false);
    expect(row.retry.decisionId).toBe(row.first.decisionId);
  });

  it('persistAuditRun does not wire a hold decision when the client has opted out via client_payment_policy', async () => {
    const inv = parse210(GOLDEN_210, testCategorize);
    const result = evaluateInvoice(inv);

    const owner = await pool.connect();
    try {
      const configuredBy = await owner.query<{ id: string }>(
        `INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-configurer@example.com`],
      );
      await owner.query(
        `INSERT INTO client_payment_policy (client_id, hold_then_approve, configured_by) VALUES ($1, false, $2)`,
        [clientId, configuredBy.rows[0]!.id],
      );
    } finally {
      owner.release();
    }

    const row = await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
      const p = await persistAuditRun(c, { clientId, invoice: inv, result, rubricSnapshotId: null });
      // Explicit call, still opted out -- must find zero rows, proving
      // persistAuditRun itself respected the policy and created none either.
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
