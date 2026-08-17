#!/usr/bin/env node
// Seeds criterion/criterion_version/rule/rule_version rows for every criterion
// currently defined in STANDARD_RUBRIC and CONTRACT_RUBRIC (86e2v2dh1).
//
// This is canonical reference data derived from the hand-authored rubric
// definitions, not a per-environment dev fixture (contrast with
// scripts/seed-dev-tenant.mjs, which explicitly is dev-only and gated on
// SEED_DEV_ON_DEPLOY) -- it must run unconditionally, in every environment
// including Production, since criterion_id/rule_version_id resolution should
// work everywhere the engine runs. Not a migration: migrations/ is
// hand-authored SQL DDL that can't import TypeScript source, and hardcoding
// these criteria into SQL would duplicate STANDARD_RUBRIC/CONTRACT_RUBRIC as a
// second source of truth that could drift from the real one.
//
// Idempotent: re-running must not create duplicate rows. criterion.criterion_key
// and rule.slug are both UNIQUE, so ON CONFLICT DO NOTHING covers those. But
// rule_version has NO unique constraint at all (migration 0006 only gives it
// two plain indexes) -- inserting it naively on every run would accumulate
// duplicate rows, and the resolver would then return a non-deterministic
// rule_version_id across environments/reruns. Guarded here with an explicit
// NOT EXISTS check on (rule_id, ast_hash) instead.

import pg from 'pg';
import { createHash } from 'node:crypto';
import { STANDARD_RUBRIC } from '../src/modules/rubric-resolver/standard-rubric.js';
import { CONTRACT_RUBRIC } from '../src/modules/rubric-resolver/contract-rubric.js';

/** JSON.stringify with recursively sorted object keys (arrays keep order) --
 * mirrors src/modules/evaluator/snapshot.ts's stableStringify so an
 * AST's hash is stable regardless of property insertion order. Duplicated
 * rather than imported: snapshot.ts hashes a whole ComposedRubric, this
 * hashes one criterion's ast in isolation, and scripts/ importing from src/
 * across a build boundary is more coupling than this one small function
 * is worth. */
function stableStringify(value) {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

function astHash(ast) {
  return createHash('sha256').update(stableStringify(ast)).digest('hex');
}

// Maps each criterionKey to a rule_type taxonomy value (migrations/0002_enums.sql).
// The Master Spec itself marks rule_type a "DRAFT taxonomy" with no existing
// mapping guidance anywhere in the codebase -- this assignment is this seed
// script's own implementer's-call, made explicit here rather than silently:
//   STRUCTURAL: required-field/presence/footing checks over the whole invoice
//   INTRA_LINE: per-line-item categorization checks (crosswalk-derived)
//   CONTRACT_CONFORMANCE: billed-vs-contracted-rate comparisons
const RULE_TYPE_BY_CRITERION_KEY = {
  'STD.FOOTING': 'STRUCTURAL',
  'STD.CURRENCY_STATED': 'STRUCTURAL',
  'STD.AMOUNT_STATED': 'STRUCTURAL',
  'STD.HAS_CHARGES': 'STRUCTURAL',
  'STD.NO_QUARANTINED_CODES': 'INTRA_LINE',
  'STD.FUEL_PRESENT': 'INTRA_LINE',
  'CONTRACT.RATE_VARIANCE': 'CONTRACT_CONFORMANCE',
};

function ruleTypeFor(criterionKey) {
  const ruleType = RULE_TYPE_BY_CRITERION_KEY[criterionKey];
  if (!ruleType) {
    throw new Error(
      `no rule_type mapping for criterionKey "${criterionKey}" -- add one to RULE_TYPE_BY_CRITERION_KEY in scripts/seed-criteria.mjs`,
    );
  }
  return ruleType;
}

/**
 * @param {object} [opts]
 * @param {pg.Pool | pg.PoolClient} [opts.client] - injectable for tests (avoids a real connection)
 * @returns {Promise<void>}
 */
export async function seedCriteria({ client } = {}) {
  const ownedPool = !client;
  const db = client ?? new pg.Pool({ connectionString: requireDatabaseUrl() });
  try {
    // Both rubrics share STANDARD_RUBRIC's criteria (CONTRACT_RUBRIC.criteria
    // spreads them in, per contract-rubric.ts) -- dedupe by criterionKey so
    // each one is only inserted once, keyed on the ComposedRubric that most
    // specifically defines it (CONTRACT_RUBRIC's copy is identical to
    // STANDARD_RUBRIC's for shared keys, so it doesn't matter which wins).
    const byKey = new Map();
    for (const c of [...STANDARD_RUBRIC.criteria, ...CONTRACT_RUBRIC.criteria]) {
      byKey.set(c.criterionKey, c);
    }

    for (const criterion of byKey.values()) {
      const critRes = await db.query(
        `INSERT INTO criterion (criterion_key, kind) VALUES ($1, $2)
         ON CONFLICT (criterion_key) DO UPDATE SET criterion_key = EXCLUDED.criterion_key
         RETURNING id`,
        [criterion.criterionKey, criterion.kind],
      );
      const criterionId = critRes.rows[0].id;

      // criterion_version is append-only (migration 0006) -- only insert a new
      // version row if the description has actually changed since the last one,
      // otherwise every re-run would pile up identical version rows forever.
      const latestVersion = await db.query(
        `SELECT description FROM criterion_version
         WHERE criterion_id = $1 ORDER BY recorded_at DESC LIMIT 1`,
        [criterionId],
      );
      if (latestVersion.rows.length === 0 || latestVersion.rows[0].description !== criterion.description) {
        await db.query(
          `INSERT INTO criterion_version (criterion_id, description) VALUES ($1, $2)`,
          [criterionId, criterion.description],
        );
      }

      const ruleSlug = criterion.criterionKey.toLowerCase().replace(/\./g, '-');
      const ruleRes = await db.query(
        `INSERT INTO rule (slug, rule_type) VALUES ($1, $2)
         ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
         RETURNING id`,
        [ruleSlug, ruleTypeFor(criterion.criterionKey)],
      );
      const ruleId = ruleRes.rows[0].id;

      const hash = astHash(criterion.ast);
      const existingVersion = await db.query(
        `SELECT id FROM rule_version WHERE rule_id = $1 AND ast_hash = $2`,
        [ruleId, hash],
      );
      if (existingVersion.rows.length === 0) {
        // Every criterion in STANDARD_RUBRIC/CONTRACT_RUBRIC is FIRM_RULE,
        // hand-authored, already in production use (standard-rubric.ts's own
        // doc comment: "born hard (FIRM_RULE) and STANDARD") -- ACTIVE is the
        // correct lifecycle_state, not PROPOSED/SHADOW.
        // emits: GATING criteria are pass/fail gates (PASS_FAIL); SCORING
        // criteria that produce a real dollar variance would be
        // DOLLAR_VARIANCE, but only CONTRACT.RATE_VARIANCE does today
        // (evaluate-invoice.ts's own comment: STD.* SCORING criteria are
        // "pass/fail integrity checks (no $ rollup)") -- so SCORING alone
        // isn't sufficient to decide this, criterionKey is checked directly.
        const emits = criterion.criterionKey === 'CONTRACT.RATE_VARIANCE' ? 'DOLLAR_VARIANCE' : 'PASS_FAIL';
        await db.query(
          `INSERT INTO rule_version (rule_id, hardness, lifecycle_state, ast, ast_hash, emits)
           VALUES ($1, 'FIRM_RULE', 'ACTIVE', $2, $3, $4)`,
          [ruleId, JSON.stringify(criterion.ast), hash, emits],
        );
      }
    }
  } finally {
    if (ownedPool) await db.end();
  }
}

/**
 * Resolves a criterionKey to its seeded criterion_id/rule_version_id pair.
 * Returns null (never throws) when the key has no seeded row -- both columns
 * are nullable on charge_finding/variance_finding (migration 0008), and a
 * caller must be able to write a finding for a criterion that predates this
 * seed step or was added to a rubric after the last seed run, without that
 * failing the whole persist.
 *
 * @param {pg.Pool | pg.PoolClient} client
 * @param {string} criterionKey
 * @returns {Promise<{ criterionId: string, ruleVersionId: string } | null>}
 */
export async function resolveCriterionIds(client, criterionKey) {
  const critRes = await client.query(`SELECT id FROM criterion WHERE criterion_key = $1`, [criterionKey]);
  if (critRes.rows.length === 0) return null;
  const criterionId = critRes.rows[0].id;

  const ruleSlug = criterionKey.toLowerCase().replace(/\./g, '-');
  const ruleVersionRes = await client.query(
    `SELECT rule_version.id
     FROM rule_version
     JOIN rule ON rule.id = rule_version.rule_id
     WHERE rule.slug = $1
     ORDER BY rule_version.recorded_at DESC
     LIMIT 1`,
    [ruleSlug],
  );
  if (ruleVersionRes.rows.length === 0) return null;

  return { criterionId, ruleVersionId: ruleVersionRes.rows[0].id };
}

function requireDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return url;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await seedCriteria();
  console.log('Seeded criterion/rule/rule_version rows from STANDARD_RUBRIC + CONTRACT_RUBRIC');
}
