import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import type pg from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { withAppTx } from './helpers.js';
import { seedCriteria, resolveCriterionIds } from '../../scripts/seed-criteria.mjs';
import { STANDARD_RUBRIC } from '../../src/modules/rubric-resolver/standard-rubric.js';
import { CONTRACT_RUBRIC } from '../../src/modules/rubric-resolver/contract-rubric.js';

/**
 * 86e2v2dh1: criterion/rule/rule_version rows for STANDARD_RUBRIC +
 * CONTRACT_RUBRIC didn't exist anywhere outside a hand-fixtured test insert
 * (test/db/list-findings.db.test.ts) -- nothing resolved a criterionKey
 * string to a real DB id. This is that seed + resolver, tested here.
 */
describe('seedCriteria + resolveCriterionIds (DB)', () => {
  afterAll(async () => {
    await closePool();
  });

  beforeAll(async () => {
    await seedCriteria({ client: getPool() });
  });

  it('seeds one criterion/rule/rule_version row set per criterion in STANDARD_RUBRIC + CONTRACT_RUBRIC', async () => {
    const pool = getPool();
    const allKeys = new Set([
      ...STANDARD_RUBRIC.criteria.map((c) => c.criterionKey),
      ...CONTRACT_RUBRIC.criteria.map((c) => c.criterionKey),
    ]);

    const criteria = await pool.query(
      `SELECT criterion_key, kind FROM criterion WHERE criterion_key = ANY($1)`,
      [[...allKeys]],
    );
    expect(criteria.rowCount).toBe(allKeys.size);

    // Spot-check the two criteria the parent item (86e2v17p5) names explicitly.
    const footing = criteria.rows.find((r) => r.criterion_key === 'STD.FOOTING');
    expect(footing?.kind).toBe('GATING');

    const rateVariance = criteria.rows.find((r) => r.criterion_key === 'CONTRACT.RATE_VARIANCE');
    expect(rateVariance?.kind).toBe('SCORING');
  });

  it('seeds a criterion_version row with the criterion definition\'s description', async () => {
    const pool = getPool();
    const footingCriterion = STANDARD_RUBRIC.criteria.find((c) => c.criterionKey === 'STD.FOOTING')!;

    const version = await pool.query(
      `SELECT criterion_version.description
       FROM criterion_version
       JOIN criterion ON criterion.id = criterion_version.criterion_id
       WHERE criterion.criterion_key = 'STD.FOOTING'
       ORDER BY criterion_version.recorded_at DESC LIMIT 1`,
    );
    expect(version.rows[0]?.description).toBe(footingCriterion.description);
  });

  it('seeds a rule_version row carrying the criterion\'s own AST, marked FIRM_RULE/ACTIVE', async () => {
    const pool = getPool();
    const rateVarianceCriterion = CONTRACT_RUBRIC.criteria.find((c) => c.criterionKey === 'CONTRACT.RATE_VARIANCE')!;

    const ruleVersion = await pool.query(
      `SELECT rule_version.ast, rule_version.hardness, rule_version.lifecycle_state, rule_version.emits
       FROM rule_version
       JOIN rule ON rule.id = rule_version.rule_id
       WHERE rule.slug = 'contract-rate_variance'`,
    );
    expect(ruleVersion.rowCount).toBe(1);
    expect(ruleVersion.rows[0].ast).toEqual(rateVarianceCriterion.ast);
    expect(ruleVersion.rows[0].hardness).toBe('FIRM_RULE');
    expect(ruleVersion.rows[0].lifecycle_state).toBe('ACTIVE');
    // CONTRACT.RATE_VARIANCE is the one criterion that produces a real dollar
    // variance (evaluate-invoice.ts's own comment) -- every other seeded
    // criterion is a pass/fail integrity check.
    expect(ruleVersion.rows[0].emits).toBe('DOLLAR_VARIANCE');
  });

  it('marks every STD.* criterion PASS_FAIL, not DOLLAR_VARIANCE', async () => {
    const pool = getPool();
    const stdRuleVersions = await pool.query(
      `SELECT rule.slug, rule_version.emits
       FROM rule_version
       JOIN rule ON rule.id = rule_version.rule_id
       WHERE rule.slug LIKE 'std-%'`,
    );
    expect(stdRuleVersions.rowCount).toBe(STANDARD_RUBRIC.criteria.length);
    for (const row of stdRuleVersions.rows) {
      expect(row.emits).toBe('PASS_FAIL');
    }
  });

  it('AC2: running the seed twice does not duplicate criterion, criterion_version, rule, or rule_version rows', async () => {
    const pool = getPool();
    const countsBefore = await getCounts(pool);

    await seedCriteria({ client: pool }); // second run

    const countsAfter = await getCounts(pool);
    expect(countsAfter).toEqual(countsBefore);
  });

  it('AC3: resolves a seeded criterionKey to its real criterion_id/rule_version_id pair', async () => {
    const pool = getPool();
    const expectedCriterionId = await pool.query(
      `SELECT id FROM criterion WHERE criterion_key = 'CONTRACT.RATE_VARIANCE'`,
    );
    const expectedRuleVersionId = await pool.query(
      `SELECT rule_version.id FROM rule_version JOIN rule ON rule.id = rule_version.rule_id WHERE rule.slug = 'contract-rate_variance'`,
    );

    const resolved = await resolveCriterionIds(pool, 'CONTRACT.RATE_VARIANCE');
    expect(resolved).toEqual({
      criterionId: expectedCriterionId.rows[0].id,
      ruleVersionId: expectedRuleVersionId.rows[0].id,
      clauseId: null,
      sourceDocumentId: null,
    });
  });

  it('AC4: returns null (not a thrown error) for a criterionKey with no seeded row', async () => {
    const pool = getPool();
    await expect(resolveCriterionIds(pool, 'NONEXISTENT.CRITERION_KEY')).resolves.toBeNull();
  });

  // 86e2v1qxz taught this session that a query which only works for a
  // superuser/owner can mask a real production failure -- criterion/rule/
  // rule_version carry no RLS (they're global reference data, confirmed
  // against migrations/0009's tenant_tables list, which omits all four), but
  // freight_app's grants on them ARE role-scoped (append-only SELECT+INSERT
  // on criterion_version/rule_version, full CRUD on criterion/rule per
  // migration 0010) -- so this proves the resolver actually works under the
  // real connecting role, not just as the test's owner/superuser connection.
  it('resolves correctly when run as freight_app, not just the owning superuser', async () => {
    const pool = getPool();
    const resolved = await withAppTx(pool, {}, (client) => resolveCriterionIds(client, 'CONTRACT.RATE_VARIANCE'));
    expect(resolved).not.toBeNull();
    expect(resolved!.criterionId).toBeTruthy();
    expect(resolved!.ruleVersionId).toBeTruthy();
  });
});

async function getCounts(pool: pg.Pool) {
  const [criterion, criterionVersion, rule, ruleVersion] = await Promise.all([
    pool.query(`SELECT count(*) FROM criterion`),
    pool.query(`SELECT count(*) FROM criterion_version`),
    pool.query(`SELECT count(*) FROM rule`),
    pool.query(`SELECT count(*) FROM rule_version`),
  ]);
  return {
    criterion: Number(criterion.rows[0].count),
    criterionVersion: Number(criterionVersion.rows[0].count),
    rule: Number(rule.rows[0].count),
    ruleVersion: Number(ruleVersion.rows[0].count),
  };
}
