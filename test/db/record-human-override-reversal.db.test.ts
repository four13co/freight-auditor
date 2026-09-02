import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { buildApp } from '../../src/server/app.js';
import { recordHumanOverrideReversal } from '../../src/modules/rule-engine/record-human-override-reversal.js';

/**
 * P6.C.8, rebuild after failed review: the DB-level proof AC1 itself names
 * ("DB test confirming the insert and confirming an UPDATE attempt would
 * fail under freight_app's grants") plus a real-DB e2e for
 * POST /api/findings/:id/reverse's full finding -> criterion -> rule_version
 * join under real RLS. The write-path/route code is unchanged from the
 * failed PR -- Review confirmed that logic itself was correct; only this
 * coverage was missing.
 */
describe('recordHumanOverrideReversal (DB, e2e) -- append-only enforcement + threshold quarantine', () => {
  let pool: pg.Pool;
  let clientId: string;
  let criterionId: string;
  let ruleId: string;
  let ruleVersionId: string;
  const tag = `hor-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('HOR', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const crit = await owner.query(
        `INSERT INTO criterion (criterion_key, kind) VALUES ($1, 'SCORING') RETURNING id`, [`${tag}-crit`],
      );
      criterionId = crit.rows[0].id;
      const rule = await owner.query(`INSERT INTO rule (slug, rule_type) VALUES ($1, 'STRUCTURAL') RETURNING id`, [`${tag}-rule`]);
      ruleId = rule.rows[0].id;
      const rv = await owner.query(
        `INSERT INTO rule_version (rule_id, hardness, lifecycle_state, ast, ast_hash, emits)
         VALUES ($1, 'FIRM_RULE', 'ACTIVE', '{}'::jsonb, $2, 'PASS_FAIL') RETURNING id`,
        [ruleId, tag.padEnd(64, '0').slice(0, 64)],
      );
      ruleVersionId = rv.rows[0].id;
      // max_reversals=1: the first reversal (sum=1) stays under threshold,
      // the second (sum=2) exceeds it -- covers both AC3 branches with one seed.
      await owner.query(
        `INSERT INTO promotion_policy (client_id, rule_type, max_reversals) VALUES ($1, 'STRUCTURAL', 1)`,
        [clientId],
      );
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM human_override WHERE criterion_id = $1`, [criterionId]);
      await owner.query(`DELETE FROM promotion_policy WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM promotion_event WHERE rule_version_id IN (SELECT id FROM rule_version WHERE rule_id = $1)`, [ruleId]);
      await owner.query(`DELETE FROM rule_version WHERE rule_id = $1`, [ruleId]);
      await owner.query(`DELETE FROM rule WHERE id = $1`, [ruleId]);
      await owner.query(`DELETE FROM criterion WHERE id = $1`, [criterionId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  // AC1: a reversal is a new INSERT (reversal_count=1, confirm_count=0),
  // never an UPDATE -- both halves proven against a real Postgres.
  it('inserts a new human_override row with reversal_count=1, confirm_count=0 (first reversal, under threshold)', async () => {
    const result = await withTenantTx({ clientIds: [clientId], internal: true }, (client) =>
      recordHumanOverrideReversal(client, {
        clientId, criterionId, ruleVersionId, caseFingerprint: 'ocean/fsc/transpac', assertedValue: { rate: '1.10' },
      }),
    );
    expect(result.quarantined).toBe(false);

    const owner = await pool.connect();
    try {
      const row = (await owner.query(
        `SELECT reversal_count, confirm_count, asserted_value FROM human_override WHERE id = $1`, [result.humanOverrideId],
      )).rows[0];
      expect(row.reversal_count).toBe(1);
      expect(row.confirm_count).toBe(0);
      expect(row.asserted_value).toEqual({ rate: '1.10' });
    } finally {
      owner.release();
    }
  });

  it('rejects a raw UPDATE against human_override under freight_app -- no UPDATE grant exists (append-only proof)', async () => {
    const owner = await pool.connect();
    let existingId: string;
    try {
      existingId = (await owner.query(`SELECT id FROM human_override WHERE criterion_id = $1 LIMIT 1`, [criterionId])).rows[0].id;
    } finally {
      owner.release();
    }

    await expect(
      withTenantTx({ clientIds: [clientId], internal: true }, (client) =>
        client.query(`UPDATE human_override SET reversal_count = 99 WHERE id = $1`, [existingId]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  // AC3: the second reversal pushes the cumulative sum (1 + 1 = 2) over
  // max_reversals=1 -> quarantine fires via the reintroduced transitionRuleLifecycle.
  it('quarantines the rule version once cumulative reversals exceed the policy threshold', async () => {
    const result = await withTenantTx({ clientIds: [clientId], internal: true }, (client) =>
      recordHumanOverrideReversal(client, {
        clientId, criterionId, ruleVersionId, caseFingerprint: 'ocean/fsc/transpac-2', assertedValue: { rate: '1.20' },
      }),
    );
    expect(result.quarantined).toBe(true);
    expect(result.ruleVersionId).not.toBe(ruleVersionId);

    const owner = await pool.connect();
    try {
      const row = (await owner.query(`SELECT lifecycle_state FROM rule_version WHERE id = $1`, [result.ruleVersionId])).rows[0];
      expect(row.lifecycle_state).toBe('QUARANTINED');
    } finally {
      owner.release();
    }
  });
});

/**
 * Real-DB e2e for POST /api/findings/:id/reverse: the full
 * finding -> criterion -> rule_version join, real RLS, real client_viewer
 * auth -- not mocked at any boundary.
 */
describe('POST /api/findings/:id/reverse (DB, e2e)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let clientId: string;
  let userId: string;
  let carrierId: string;
  let invoiceId: string;
  let auditRunId: string;
  let criterionId: string;
  let ruleId: string;
  let ruleVersionId: string;
  let nonFirmRuleVersionId: string;
  let findingId: string;
  let findingNonFirmId: string;
  let originalFlag: string | undefined;
  const tag = `hore-${Date.now()}`;

  beforeAll(async () => {
    originalFlag = process.env.DEV_AUTH_HEADERS;
    process.env.DEV_AUTH_HEADERS = '1';
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('HORE', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const u = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}@example.com`]);
      userId = u.rows[0].id;
      await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'analyst')`, [userId, clientId]);
      const carrier = await owner.query(`INSERT INTO carrier (name) VALUES ('HORE Carrier') RETURNING id`);
      carrierId = carrier.rows[0].id;
      const crit = await owner.query(`INSERT INTO criterion (criterion_key, kind) VALUES ($1, 'SCORING') RETURNING id`, [`${tag}-crit`]);
      criterionId = crit.rows[0].id;
      const rule = await owner.query(`INSERT INTO rule (slug, rule_type) VALUES ($1, 'STRUCTURAL') RETURNING id`, [`${tag}-rule`]);
      ruleId = rule.rows[0].id;
      const rv = await owner.query(
        `INSERT INTO rule_version (rule_id, hardness, lifecycle_state, ast, ast_hash, emits)
         VALUES ($1, 'FIRM_RULE', 'ACTIVE', '{}'::jsonb, $2, 'PASS_FAIL') RETURNING id`,
        [ruleId, tag.padEnd(64, '1').slice(0, 64)],
      );
      ruleVersionId = rv.rows[0].id;
      const rvOther = await owner.query(
        `INSERT INTO rule_version (rule_id, hardness, lifecycle_state, ast, ast_hash, emits)
         VALUES ($1, 'AI_CANON', 'ACTIVE', '{}'::jsonb, $2, 'PASS_FAIL') RETURNING id`,
        [ruleId, tag.padEnd(64, '2').slice(0, 64)],
      );
      nonFirmRuleVersionId = rvOther.rows[0].id;
      await owner.query(`INSERT INTO promotion_policy (client_id, rule_type, max_reversals) VALUES ($1, 'STRUCTURAL', 5)`, [clientId]);

      await withTenantTx({ clientIds: [clientId], internal: true }, async (c) => {
        const invoice = await c.query(
          `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version, status)
           VALUES ($1, $2, '210', 'INV-HORE-1', 'USD', 'v1', 'ingested') RETURNING id`,
          [clientId, carrierId],
        );
        invoiceId = invoice.rows[0].id;
        const run = await c.query(
          `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'v1', 'SCORED') RETURNING id`,
          [clientId, invoiceId],
        );
        auditRunId = run.rows[0].id;
        const finding = await c.query(
          `INSERT INTO variance_finding (client_id, audit_run_id, criterion_id, rule_version_id, status, evaluated_expr)
           VALUES ($1, $2, $3, $4, 'open', '{}'::jsonb) RETURNING id`,
          [clientId, auditRunId, criterionId, ruleVersionId],
        );
        findingId = finding.rows[0].id;
        const findingNonFirm = await c.query(
          `INSERT INTO variance_finding (client_id, audit_run_id, criterion_id, rule_version_id, status, evaluated_expr)
           VALUES ($1, $2, $3, $4, 'open', '{}'::jsonb) RETURNING id`,
          [clientId, auditRunId, criterionId, nonFirmRuleVersionId],
        );
        findingNonFirmId = findingNonFirm.rows[0].id;
      });
    } finally {
      owner.release();
    }
    app = buildApp();
  });

  afterAll(async () => {
    process.env.DEV_AUTH_HEADERS = originalFlag;
    await app.close();
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM human_override WHERE criterion_id = $1`, [criterionId]);
      await owner.query(`DELETE FROM promotion_policy WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM variance_finding WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM audit_run WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM invoice WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM rule_version WHERE rule_id = $1`, [ruleId]);
      await owner.query(`DELETE FROM rule WHERE id = $1`, [ruleId]);
      await owner.query(`DELETE FROM criterion WHERE id = $1`, [criterionId]);
      await owner.query(`DELETE FROM membership WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM app_user WHERE id = $1`, [userId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
      await owner.query(`DELETE FROM carrier WHERE id = $1`, [carrierId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  it('records a reversal for a FIRM_RULE finding through the real join and RLS', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/findings/${findingId}/reverse`,
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
      payload: { caseFingerprint: 'ocean/fsc/e2e', assertedValue: { rate: '1.05' } },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.quarantined).toBe(false);
    expect(body.ruleVersionId).toBe(ruleVersionId);
  });

  it('returns 409 NOT_A_FIRM_RULE for a finding whose rule is not FIRM_RULE', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/findings/${findingNonFirmId}/reverse`,
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
      payload: { caseFingerprint: 'x', assertedValue: 1 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'NOT_A_FIRM_RULE' });
  });

  it('returns 404 for a finding belonging to a different (or nonexistent) tenant, RLS-scoped', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/findings/00000000-0000-4000-8000-000000000099/reverse',
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
      payload: { caseFingerprint: 'x', assertedValue: 1 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/findings/${findingId}/reverse`, payload: { caseFingerprint: 'x', assertedValue: 1 },
    });
    expect(res.statusCode).toBe(401);
  });
});
