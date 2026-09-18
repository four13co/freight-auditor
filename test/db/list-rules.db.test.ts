import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { makePool } from './helpers.js';
import { listRules } from '../../src/modules/rule-engine/list-rules.js';
import { transitionRuleLifecycle } from '../../src/modules/rule-engine/transition-rule-lifecycle.js';

/**
 * 86e3a6rg1: the Rules tab's list query. Covers the "current version only"
 * predicate (a superseded row must not reappear alongside its successor),
 * the tier/kind derivation through criterion_rule -> criterion_version ->
 * criterion_membership -> rubric_version -> rubric, and server-side
 * filter/sort/pagination.
 *
 * Seeding uses a raw (non-transactional) connection, not withOwnerTx --
 * withOwnerTx always rolls back (by design, for isolated read assertions),
 * which would silently discard this fixture data before any test ran.
 * Matches contract-rate-rls.db.test.ts's own beforeAll/afterAll shape.
 */
describe('listRules (db)', () => {
  let pool: pg.Pool;
  const tag = `lr-${Date.now()}`;
  let clientId: string;
  let ruleGatingStandardId: string; // ACTIVE, STANDARD tier, GATING
  let ruleScoringClientId: string; // PROPOSED, CLIENT tier, SCORING
  let ruleNoCriterionId: string; // QUARANTINED, no criterion wiring at all
  let standardRubricId: string;
  let clientRubricId: string;

  beforeAll(async () => {
    pool = makePool();
    const owner = await pool.connect();
    try {
      const client = await owner.query(`INSERT INTO account (name, slug) VALUES ('LR Client', $1) RETURNING id`, [tag]);
      clientId = client.rows[0].id;

      const gatingCriterion = await owner.query(
        `INSERT INTO criterion (criterion_key, kind) VALUES ($1, 'GATING') RETURNING id`,
        [`${tag}-gating-key`],
      );
      const scoringCriterion = await owner.query(
        `INSERT INTO criterion (criterion_key, kind) VALUES ($1, 'SCORING') RETURNING id`,
        [`${tag}-scoring-key`],
      );
      const gatingCriterionVersion = await owner.query(
        `INSERT INTO criterion_version (criterion_id) VALUES ($1) RETURNING id`,
        [gatingCriterion.rows[0].id],
      );
      const scoringCriterionVersion = await owner.query(
        `INSERT INTO criterion_version (criterion_id) VALUES ($1) RETURNING id`,
        [scoringCriterion.rows[0].id],
      );

      const standardRubric = await owner.query(
        `INSERT INTO rubric (tier, scope_account_id, scope_contract_id) VALUES ('STANDARD', NULL, NULL) RETURNING id`,
      );
      const clientRubric = await owner.query(
        `INSERT INTO rubric (tier, scope_account_id, scope_contract_id) VALUES ('CLIENT', $1, NULL) RETURNING id`,
        [clientId],
      );
      standardRubricId = standardRubric.rows[0].id;
      clientRubricId = clientRubric.rows[0].id;
      const standardRubricVersion = await owner.query(
        `INSERT INTO rubric_version (rubric_id) VALUES ($1) RETURNING id`,
        [standardRubric.rows[0].id],
      );
      const clientRubricVersion = await owner.query(
        `INSERT INTO rubric_version (rubric_id) VALUES ($1) RETURNING id`,
        [clientRubric.rows[0].id],
      );
      await owner.query(
        `INSERT INTO criterion_membership (rubric_version_id, criterion_key) VALUES ($1, $2)`,
        [standardRubricVersion.rows[0].id, `${tag}-gating-key`],
      );
      await owner.query(
        `INSERT INTO criterion_membership (rubric_version_id, criterion_key) VALUES ($1, $2)`,
        [clientRubricVersion.rows[0].id, `${tag}-scoring-key`],
      );

      const ruleA = await owner.query(`INSERT INTO rule (slug, rule_type) VALUES ($1, 'STRUCTURAL') RETURNING id`, [`${tag}-rule-a`]);
      const ruleB = await owner.query(`INSERT INTO rule (slug, rule_type) VALUES ($1, 'INTRA_LINE') RETURNING id`, [`${tag}-rule-b`]);
      const ruleC = await owner.query(`INSERT INTO rule (slug, rule_type) VALUES ($1, 'CROSS_REFERENCE') RETURNING id`, [`${tag}-rule-c`]);
      ruleGatingStandardId = ruleA.rows[0].id;
      ruleScoringClientId = ruleB.rows[0].id;
      ruleNoCriterionId = ruleC.rows[0].id;

      await owner.query(
        `INSERT INTO rule_version (rule_id, hardness, lifecycle_state, ast, ast_hash, emits)
         VALUES ($1, 'FIRM_RULE', 'ACTIVE', '{}'::jsonb, $2, 'PASS_FAIL')`,
        [ruleGatingStandardId, 'a'.repeat(64)],
      );
      await owner.query(
        `INSERT INTO rule_version (rule_id, hardness, lifecycle_state, ast, ast_hash, emits)
         VALUES ($1, 'HUMAN_INPUT', 'PROPOSED', '{}'::jsonb, $2, 'DOLLAR_VARIANCE')`,
        [ruleScoringClientId, 'b'.repeat(64)],
      );
      await owner.query(
        `INSERT INTO rule_version (rule_id, hardness, lifecycle_state, ast, ast_hash, emits)
         VALUES ($1, 'AI_DOCS', 'QUARANTINED', '{}'::jsonb, $2, 'PASS_FAIL')`,
        [ruleNoCriterionId, 'c'.repeat(64)],
      );

      await owner.query(
        `INSERT INTO criterion_rule (criterion_version_id, rule_id, role) VALUES ($1, $2, 'PRIMARY')`,
        [gatingCriterionVersion.rows[0].id, ruleGatingStandardId],
      );
      await owner.query(
        `INSERT INTO criterion_rule (criterion_version_id, rule_id, role) VALUES ($1, $2, 'PRIMARY')`,
        [scoringCriterionVersion.rows[0].id, ruleScoringClientId],
      );
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      const ruleIds = [ruleGatingStandardId, ruleScoringClientId, ruleNoCriterionId];
      await owner.query(`DELETE FROM criterion_rule WHERE rule_id = ANY($1)`, [ruleIds]);
      await owner.query(`DELETE FROM promotion_event WHERE rule_version_id IN (SELECT id FROM rule_version WHERE rule_id = ANY($1))`, [ruleIds]);
      await owner.query(`DELETE FROM rule_version WHERE rule_id = ANY($1)`, [ruleIds]);
      await owner.query(`DELETE FROM rule WHERE id = ANY($1)`, [ruleIds]);
      await owner.query(`DELETE FROM criterion_membership WHERE criterion_key LIKE $1`, [`${tag}-%`]);
      await owner.query(`DELETE FROM rubric_version WHERE rubric_id = ANY($1)`, [[standardRubricId, clientRubricId]]);
      await owner.query(`DELETE FROM rubric WHERE id = ANY($1)`, [[standardRubricId, clientRubricId]]);
      await owner.query(`DELETE FROM criterion_version WHERE criterion_id IN (SELECT id FROM criterion WHERE criterion_key LIKE $1)`, [`${tag}-%`]);
      await owner.query(`DELETE FROM criterion WHERE criterion_key LIKE $1`, [`${tag}-%`]);
      await owner.query(`DELETE FROM account WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await pool.end();
  });

  it('lists the current version of every rule regardless of lifecycle state', async () => {
    const client = await pool.connect();
    try {
      const result = await listRules(client, { limit: 100, offset: 0 });
      const ids = result.rows.map((r) => r.ruleId);
      expect(ids).toEqual(expect.arrayContaining([ruleGatingStandardId, ruleScoringClientId, ruleNoCriterionId]));
    } finally {
      client.release();
    }
  });

  it('derives tier and kind through the criterion/rubric join for a wired rule', async () => {
    const client = await pool.connect();
    try {
      const result = await listRules(client, { limit: 100, offset: 0 });
      const gatingRow = result.rows.find((r) => r.ruleId === ruleGatingStandardId)!;
      const scoringRow = result.rows.find((r) => r.ruleId === ruleScoringClientId)!;
      expect(gatingRow).toMatchObject({ tier: 'STANDARD', kind: 'GATING', status: 'ACTIVE' });
      expect(scoringRow).toMatchObject({ tier: 'CLIENT', kind: 'SCORING', status: 'PROPOSED' });
    } finally {
      client.release();
    }
  });

  it('leaves tier/kind null for a rule with no criterion_rule wiring', async () => {
    const client = await pool.connect();
    try {
      const result = await listRules(client, { limit: 100, offset: 0 });
      const row = result.rows.find((r) => r.ruleId === ruleNoCriterionId)!;
      expect(row.tier).toBeNull();
      expect(row.kind).toBeNull();
      expect(row.status).toBe('QUARANTINED');
    } finally {
      client.release();
    }
  });

  it('filters by status', async () => {
    const client = await pool.connect();
    try {
      const result = await listRules(client, { status: 'ACTIVE', limit: 100, offset: 0 });
      expect(result.rows.some((r) => r.ruleId === ruleGatingStandardId)).toBe(true);
      expect(result.rows.some((r) => r.ruleId === ruleScoringClientId)).toBe(false);
    } finally {
      client.release();
    }
  });

  it('filters by tier', async () => {
    const client = await pool.connect();
    try {
      const result = await listRules(client, { tier: 'CLIENT', limit: 100, offset: 0 });
      expect(result.rows.some((r) => r.ruleId === ruleScoringClientId)).toBe(true);
      expect(result.rows.some((r) => r.ruleId === ruleGatingStandardId)).toBe(false);
    } finally {
      client.release();
    }
  });

  it('filters by kind', async () => {
    const client = await pool.connect();
    try {
      const result = await listRules(client, { kind: 'GATING', limit: 100, offset: 0 });
      expect(result.rows.some((r) => r.ruleId === ruleGatingStandardId)).toBe(true);
      expect(result.rows.some((r) => r.ruleId === ruleScoringClientId)).toBe(false);
    } finally {
      client.release();
    }
  });

  it('sorts by name ascending and paginates with an accurate total', async () => {
    const client = await pool.connect();
    try {
      const page1 = await listRules(client, { sortKey: 'name', sortDirection: 'asc', limit: 1, offset: 0 });
      expect(page1.total).toBeGreaterThanOrEqual(3);
      expect(page1.rows).toHaveLength(1);
      const page2 = await listRules(client, { sortKey: 'name', sortDirection: 'asc', limit: 1, offset: 1 });
      expect(page2.rows[0]!.slug).not.toBe(page1.rows[0]!.slug);
    } finally {
      client.release();
    }
  });

  it('a superseded rule_version does not reappear once it has a successor', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const before = await listRules(client, { limit: 100, offset: 0 });
      const activeRows = before.rows.filter((r) => r.ruleId === ruleGatingStandardId);
      expect(activeRows).toHaveLength(1);
      const currentId = activeRows[0]!.ruleVersionId;

      const transition = await transitionRuleLifecycle(client, { ruleVersionId: currentId, to: 'DEPRECATED', rationale: 'test' });

      const after = await listRules(client, { limit: 100, offset: 0 });
      const rowsForRule = after.rows.filter((r) => r.ruleId === ruleGatingStandardId);
      expect(rowsForRule).toHaveLength(1);
      expect(rowsForRule[0]!.ruleVersionId).toBe(transition.ruleVersionId);
      expect(rowsForRule[0]!.status).toBe('DEPRECATED');
      await client.query('ROLLBACK');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
});
