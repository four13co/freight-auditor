import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makePool, withAppTx, withOwnerTx } from './helpers.js';
import { setTenantTxScope, type TenantContext } from '../../src/db/tenant-context.js';
import { persistBacktest } from '../../src/modules/rule-engine/persist-backtest.js';
import { promoteShadowRule } from '../../src/modules/rule-engine/promote-shadow-rule.js';
import { transitionRuleLifecycle } from '../../src/modules/rule-engine/transition-rule-lifecycle.js';

/**
 * rule_backtest / rule_backtest_case (0031) and charge_alignment_member (0024)
 * each defined a tenant_isolation policy checking the never-set
 * current_setting('app.client_id', true)::uuid GUC instead of the real
 * app_current_client_ids()-based predicate every other tenant table uses
 * (0009). With FORCE ROW LEVEL SECURITY that made every check evaluate NULL
 * (fail), so persistBacktest threw a real RLS violation and
 * promoteShadowRule's backtest lookup always saw zero rows. 0071 fixes the
 * predicate via apply_tenant_rls (ClickUp 86e32tfw8).
 */
describe('rule_backtest / rule_backtest_case / charge_alignment_member RLS (86e32tfw8)', () => {
  let pool: pg.Pool;
  const tag = `rls-guc-${Date.now()}`;
  let clientId: string;
  let otherClientId: string;
  let ruleId: string;
  let shadowVersionId: string;

  /** Like withAppTx, but COMMITs -- for writes this suite needs to persist and read back. */
  async function committedAppTx<T>(ctx: TenantContext, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await setTenantTxScope(client, ctx);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    pool = makePool();
    clientId = (await pool.query(`INSERT INTO client(name,slug) VALUES('RLS GUC',$1) RETURNING id`, [tag])).rows[0].id;
    otherClientId = (await pool.query(`INSERT INTO client(name,slug) VALUES('RLS GUC Other',$1) RETURNING id`,
      [`${tag}-other`])).rows[0].id;
    ruleId = (await pool.query(`INSERT INTO rule(slug, rule_type) VALUES ($1, 'STRUCTURAL') RETURNING id`, [tag])).rows[0].id;
    const proposed = await pool.query(
      `INSERT INTO rule_version(rule_id, hardness, lifecycle_state, ast, ast_hash, emits)
       VALUES ($1, 'AI_DOCS', 'PROPOSED', '{}'::jsonb, $2, 'PASS_FAIL') RETURNING id`,
      [ruleId, 'a'.repeat(64)],
    );
    // rule/rule_version carry no client_id (global tables, outside RLS -- 0009), so
    // this setup transition runs as the owning role directly -- but must COMMIT
    // (unlike withOwnerTx, which always rolls back and is only for read setup),
    // since shadowVersionId is read back by later, separately-committed tests.
    const setupClient = await pool.connect();
    try {
      await setupClient.query('BEGIN');
      const shadow = await transitionRuleLifecycle(setupClient, {
        ruleVersionId: proposed.rows[0].id, to: 'SHADOW', rationale: 'test setup',
      });
      await setupClient.query('COMMIT');
      shadowVersionId = shadow.ruleVersionId;
    } catch (error) {
      await setupClient.query('ROLLBACK');
      throw error;
    } finally {
      setupClient.release();
    }
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM charge_alignment_member WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
    await pool.query(`DELETE FROM charge_alignment WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
    await pool.query(`DELETE FROM charge_fact WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
    await pool.query(`DELETE FROM audit_run WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
    await pool.query(`DELETE FROM invoice WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
    await pool.query(`DELETE FROM carrier WHERE name=$1`, [tag]);
    await pool.query(`DELETE FROM promotion_event WHERE rule_version_id IN (SELECT id FROM rule_version WHERE rule_id=$1)`, [ruleId]);
    await pool.query(`DELETE FROM rule_backtest_case WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
    await pool.query(`DELETE FROM rule_backtest WHERE client_id = ANY($1)`, [[clientId, otherClientId]]);
    await pool.query(`DELETE FROM rule_version WHERE rule_id=$1`, [ruleId]);
    await pool.query(`DELETE FROM rule WHERE id=$1`, [ruleId]);
    await pool.query(`DELETE FROM client WHERE id = ANY($1)`, [[clientId, otherClientId]]);
    await pool.end();
  });

  it('rule_backtest, rule_backtest_case, and charge_alignment_member each carry a tenant_isolation policy under FORCE RLS', async () => {
    await withOwnerTx(pool, async (c) => {
      for (const table of ['rule_backtest', 'rule_backtest_case', 'charge_alignment_member']) {
        const { rows } = await c.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname=$1`, [table]);
        expect(rows[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
        const pol = await c.query(`SELECT polname FROM pg_policy WHERE polrelid=$1::regclass`, [table]);
        expect(pol.rows.map((r: { polname: string }) => r.polname)).toEqual(['tenant_isolation']);
      }
    });
  });

  it('persistBacktest, run through the real app-role tenant-context path, succeeds without an RLS violation and stays tenant-scoped', async () => {
    const result = {
      corpusHash: 'c'.repeat(64), passed: true, passCount: 1, regressionCount: 0,
      cases: [{ id: 'case-1', passed: true, inputHash: 'd'.repeat(64), expectedHash: 'e'.repeat(64), actualHash: 'e'.repeat(64), actual: { ok: true } }],
    };
    const persisted = await committedAppTx({ clientIds: [clientId] }, (client) =>
      persistBacktest(client, { clientId, ruleVersionId: shadowVersionId, result }));
    expect(persisted.created).toBe(true);

    const row = (await pool.query(`SELECT client_id, rule_version_id, passed FROM rule_backtest WHERE id=$1`, [persisted.id])).rows[0];
    expect(row).toMatchObject({ client_id: clientId, rule_version_id: shadowVersionId, passed: true });
    const cases = (await pool.query(`SELECT case_key FROM rule_backtest_case WHERE backtest_id=$1`, [persisted.id])).rows;
    expect(cases.map((r: { case_key: string }) => r.case_key)).toEqual(['case-1']);

    expect(await withAppTx(pool, { clientIds: [otherClientId] }, async (client) =>
      (await client.query(`SELECT id FROM rule_backtest WHERE id=$1`, [persisted.id])).rows)).toEqual([]);
  });

  it('promoteShadowRule, run through the real app-role tenant-context path, finds the passing backtest and does not throw BacktestRequiredError', async () => {
    const promotion = await committedAppTx({ clientIds: [clientId] }, (client) =>
      promoteShadowRule(client, { ruleVersionId: shadowVersionId, rationale: 'passing backtest on file' }));
    expect(promotion.created).toBe(true);
    const activated = (await pool.query(`SELECT lifecycle_state FROM rule_version WHERE id=$1`, [promotion.ruleVersionId])).rows[0];
    expect(activated.lifecycle_state).toBe('ACTIVE');
  });

  it('charge_alignment_member enforces the same fixed tenant predicate for real app-role reads and writes', async () => {
    const carrierId = (await pool.query(`INSERT INTO carrier(name) VALUES($1) RETURNING id`, [tag])).rows[0].id;
    const invoiceId = (await pool.query(
      `INSERT INTO invoice(client_id, carrier_id, transaction_set, parser_version) VALUES ($1, $2, '210', 'test') RETURNING id`,
      [clientId, carrierId],
    )).rows[0].id;
    const auditRunId = (await pool.query(
      `INSERT INTO audit_run(client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'test', 'SCORED') RETURNING id`,
      [clientId, invoiceId],
    )).rows[0].id;
    const chargeFactId = (await pool.query(
      `INSERT INTO charge_fact(client_id, invoice_id, amount, currency) VALUES ($1, $2, 10.00, 'USD') RETURNING id`,
      [clientId, invoiceId],
    )).rows[0].id;
    const alignmentId = (await pool.query(`INSERT INTO charge_alignment(client_id, audit_run_id) VALUES ($1, $2) RETURNING id`,
      [clientId, auditRunId])).rows[0].id;

    const memberId = await committedAppTx({ clientIds: [clientId] }, async (client) => {
      const inserted = await client.query(
        `INSERT INTO charge_alignment_member(alignment_id, charge_fact_id, client_id) VALUES ($1, $2, $3) RETURNING id`,
        [alignmentId, chargeFactId, clientId],
      );
      return inserted.rows[0].id as string;
    });
    expect(memberId).toBeTruthy();

    expect(await withAppTx(pool, { clientIds: [clientId] }, async (client) =>
      (await client.query(`SELECT id FROM charge_alignment_member WHERE id=$1`, [memberId])).rows)).toHaveLength(1);
    expect(await withAppTx(pool, { clientIds: [otherClientId] }, async (client) =>
      (await client.query(`SELECT id FROM charge_alignment_member WHERE id=$1`, [memberId])).rows)).toEqual([]);
  });
});
