import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { closePool, getPool } from '../../src/db/pool.js';
import { resolveActiveRuleVersion } from '../../src/modules/rubric-resolver/resolve-active-rule-version.js';

describe('ACTIVE rule resolution (DB)', () => {
  let pool: pg.Pool;
  let ruleId: string;
  let firmId: string;
  const slug = `active-rule-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    ruleId = (await pool.query(
      `INSERT INTO rule (slug, rule_type) VALUES ($1, 'STRUCTURAL') RETURNING id`, [slug],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO rule_version (rule_id, hardness, lifecycle_state, ast, ast_hash, emits, valid_from, recorded_at)
       VALUES ($1, 'AI_DOCS', 'ACTIVE', '{}', $2, 'PASS_FAIL', '2026-01-01', '2026-02-01T00:00:00Z')`,
      [ruleId, 'a'.repeat(64)],
    );
    firmId = (await pool.query(
      `INSERT INTO rule_version (rule_id, hardness, lifecycle_state, ast, ast_hash, emits, valid_from, recorded_at)
       VALUES ($1, 'FIRM_RULE', 'ACTIVE', '{}', $2, 'PASS_FAIL', '2026-01-01', '2026-03-01T00:00:00Z') RETURNING id`,
      [ruleId, 'b'.repeat(64)],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO rule_version (rule_id, hardness, lifecycle_state, ast, ast_hash, emits, valid_from, recorded_at)
       VALUES ($1, 'FIRM_RULE', 'QUARANTINED', '{}', $2, 'PASS_FAIL', '2026-01-01', '2026-04-01T00:00:00Z')`,
      [ruleId, 'c'.repeat(64)],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM rule_version WHERE rule_id = $1`, [ruleId]);
    await pool.query(`DELETE FROM rule WHERE id = $1`, [ruleId]);
    await closePool();
  });

  it('chooses the strongest ACTIVE version and excludes quarantined versions', async () => {
    await expect(resolveActiveRuleVersion(pool as never, {
      ruleId, effectiveOn: '2026-08-01', recordedAsOf: '2026-08-25T00:00:00Z',
    })).resolves.toMatchObject({ status: 'FOUND', ruleVersionId: firmId, hardness: 'FIRM_RULE' });
  });
});
