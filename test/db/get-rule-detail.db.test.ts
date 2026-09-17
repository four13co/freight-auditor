import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { makePool } from './helpers.js';
import { getRuleDetail } from '../../src/modules/rule-engine/get-rule-detail.js';
import { transitionRuleLifecycle } from '../../src/modules/rule-engine/transition-rule-lifecycle.js';

describe('getRuleDetail (db)', () => {
  let pool: pg.Pool;
  const tag = `grd-${Date.now()}`;
  let ruleId: string;
  let ruleVersionId: string;
  const ast = { op: 'GTE', field: 'amount', value: 100 };

  beforeAll(async () => {
    pool = makePool();
    const owner = await pool.connect();
    try {
      const rule = await owner.query(`INSERT INTO rule (slug, rule_type) VALUES ($1, 'STRUCTURAL') RETURNING id`, [`${tag}-rule`]);
      ruleId = rule.rows[0].id;
      const rv = await owner.query(
        `INSERT INTO rule_version (rule_id, hardness, lifecycle_state, ast, ast_hash, emits, expected_inputs, provenance)
         VALUES ($1, 'AI_CANON', 'SHADOW', $2::jsonb, $3, 'PASS_FAIL', '["amount"]'::jsonb, '{"source":"test"}'::jsonb) RETURNING id`,
        [ruleId, JSON.stringify(ast), 'd'.repeat(64)],
      );
      ruleVersionId = rv.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM promotion_event WHERE rule_version_id IN (SELECT id FROM rule_version WHERE rule_id = $1)`, [ruleId]);
      await owner.query(`DELETE FROM rule_version WHERE rule_id = $1`, [ruleId]);
      await owner.query(`DELETE FROM rule WHERE id = $1`, [ruleId]);
    } finally {
      owner.release();
    }
    await pool.end();
  });

  it('returns null for an unknown rule version id', async () => {
    const client = await pool.connect();
    try {
      const result = await getRuleDetail(client, '00000000-0000-4000-8000-000000000000');
      expect(result).toBeNull();
    } finally {
      client.release();
    }
  });

  it('returns the full predicate AST and metadata, with tier/kind null when unwired', async () => {
    const client = await pool.connect();
    try {
      const detail = await getRuleDetail(client, ruleVersionId);
      expect(detail).toMatchObject({
        ruleVersionId, ruleId, slug: `${tag}-rule`, ruleType: 'STRUCTURAL',
        tier: null, kind: null, status: 'SHADOW', hardness: 'AI_CANON', emits: 'PASS_FAIL',
        ast, expectedInputs: ['amount'], provenance: { source: 'test' },
      });
    } finally {
      client.release();
    }
  });

  it('includes promotion_event history after a lifecycle transition', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const transition = await transitionRuleLifecycle(client, { ruleVersionId, to: 'QUARANTINED', rationale: 'flagged by reversal policy' });
      const detail = await getRuleDetail(client, transition.ruleVersionId);
      expect(detail!.history).toHaveLength(1);
      expect(detail!.history[0]).toMatchObject({
        fromLifecycle: 'SHADOW', toLifecycle: 'QUARANTINED', direction: 'DEMOTE', rationale: 'flagged by reversal policy',
      });
      await client.query('ROLLBACK');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
});
