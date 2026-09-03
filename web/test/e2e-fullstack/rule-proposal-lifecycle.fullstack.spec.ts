import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DEV_CLIENT_ID } from '../../../scripts/seed-dev-tenant.mjs';

// 86e33qz9j: full-stack e2e for RuleProposalQueue.tsx's real 2-stage
// lifecycle (PROPOSED -> SHADOW -> ACTIVE) -- real Fastify server + real
// Postgres, no route mocking.
//
// Per this task's own reshape note, the real lifecycle is 2-stage, not the
// original AC's fabricated 3-verb (accept/ratify/activate) composite: "Ratify
// to shadow" (PROPOSED -> SHADOW, POST /api/rules/:id/ratify) then "Activate"
// (SHADOW -> ACTIVE, POST /api/rules/:id/activate). The dropped "accept" verb
// belongs to a different component/track entirely (ContractRubricPreview.tsx's
// contract-rule-proposal flow) -- out of scope per this task's own No-gos.
//
// rule/rule_version are GLOBAL tables (no client_id, no RLS) -- confirmed via
// migrations/0006_rubric_rule_grid.sql and absence from apply_tenant_rls's
// pairs list -- so seeding is a plain INSERT, no withTenantTx needed.
//
// A real, load-bearing quirk this spec works around rather than papering
// over: transitionRuleLifecycle (src/modules/rule-engine/transition-rule-
// lifecycle.ts) never mutates a rule_version row in place -- each transition
// INSERTs a NEW immutable row (predecessor_rule_version_id linking back) and
// returns its id. Dashboard.tsx's own onRatified handler patches the
// EXISTING row object's lifecycle_state locally (for the immediate "button
// swap, no reload" UI feedback AC2 describes) but keeps the OLD id -- it
// never swaps in the real new id the ratify response returns. Acting on that
// same in-memory row a second time would target the wrong (stale) rule_version
// id. This spec asserts AC2's own claim (the live button swap) against that
// same page, then reloads before AC3's Activate click, which re-fetches
// GET /api/rules/proposals fresh and correctly returns the real SHADOW row
// under its own id -- the same "reload between independently-stated Given
// clauses" allowance already used for ReviewQueues' AC2 (86e33qz8v), not the
// stricter "without a full reload" bar that's specific to P7.B.1's
// FindingDetail/Dashboard.tsx row-patch claim.

const SLUG = `p7b5-test-rule-${Date.now()}`;

let pool: pg.Pool;
let ruleId: string;
let ruleVersionId: string;
let shadowRuleVersionId: string;

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  const rule = await pool.query<{ id: string }>(`INSERT INTO rule (slug, rule_type) VALUES ($1, 'STRUCTURAL') RETURNING id`, [SLUG]);
  ruleId = rule.rows[0]!.id;
  const rv = await pool.query<{ id: string }>(
    `INSERT INTO rule_version (rule_id, hardness, lifecycle_state, ast, ast_hash, emits)
     VALUES ($1, 'AI_CANON', 'PROPOSED', '{}'::jsonb, $2, 'PASS_FAIL') RETURNING id`,
    [ruleId, SLUG.padEnd(64, '0').slice(0, 64)],
  );
  ruleVersionId = rv.rows[0]!.id;
});

test.afterAll(async () => {
  // promotion_event references rule_backtest_id -- delete it first.
  await pool.query(`DELETE FROM promotion_event WHERE rule_version_id IN (SELECT id FROM rule_version WHERE rule_id = $1)`, [ruleId]);
  await pool.query(`DELETE FROM rule_backtest WHERE rule_version_id IN (SELECT id FROM rule_version WHERE rule_id = $1)`, [ruleId]);
  await pool.query(`DELETE FROM audit_event WHERE entity = 'rule_version' AND entity_id IN (SELECT id FROM rule_version WHERE rule_id = $1)`, [ruleId]);
  await pool.query(`DELETE FROM rule_version WHERE rule_id = $1`, [ruleId]);
  await pool.query(`DELETE FROM rule WHERE id = $1`, [ruleId]);
  await pool.end();
});

test.use({ viewport: { width: 1600, height: 1400 } });

test('AC1: a seeded PROPOSED rule proposal renders with its slug, rule type, hardness, and lifecycle state, and only a Ratify to shadow button', async ({ page }) => {
  await page.goto('/');

  const queue = page.getByTestId('rule-proposal-queue');
  await expect(queue).toBeVisible();

  const row = queue.locator('div').filter({ hasText: SLUG });
  await expect(row).toContainText(SLUG);
  await expect(row).toContainText('STRUCTURAL');
  await expect(row).toContainText('AI_CANON');
  await expect(row).toContainText('PROPOSED');
  await expect(row.getByRole('button', { name: 'Ratify to shadow' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Activate' })).toHaveCount(0);
});

test('AC2: clicking Ratify to shadow moves the proposal to SHADOW and swaps in an Activate button live, no reload', async ({ page }) => {
  await page.goto('/');

  const queue = page.getByTestId('rule-proposal-queue');
  const row = queue.locator('div').filter({ hasText: SLUG });
  await expect(row).toBeVisible();

  const ratifyPost = page.waitForResponse((res) => res.url().includes(`/api/rules/${ruleVersionId}/ratify`) && res.request().method() === 'POST');
  await row.getByRole('button', { name: 'Ratify to shadow' }).click();
  const ratifyResponse = await ratifyPost;
  expect(ratifyResponse.status()).toBe(201);
  const ratifyBody = await ratifyResponse.json() as { ruleVersionId: string; created: boolean };
  shadowRuleVersionId = ratifyBody.ruleVersionId;
  expect(shadowRuleVersionId).not.toBe(ruleVersionId);

  // The live button swap, without a reload -- Dashboard.tsx's onRatified
  // patches the row's lifecycle_state locally as soon as the POST resolves.
  await expect(row.getByRole('button', { name: 'Ratify to shadow' })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Activate' })).toBeVisible();

  const newRow = await pool.query<{ lifecycle_state: string }>(`SELECT lifecycle_state FROM rule_version WHERE id = $1`, [shadowRuleVersionId]);
  expect(newRow.rows[0]!.lifecycle_state).toBe('SHADOW');
  // The original PROPOSED row is never mutated -- transitionRuleLifecycle is
  // append-only, so this confirms the two are genuinely distinct rows.
  const originalRow = await pool.query<{ lifecycle_state: string }>(`SELECT lifecycle_state FROM rule_version WHERE id = $1`, [ruleVersionId]);
  expect(originalRow.rows[0]!.lifecycle_state).toBe('PROPOSED');
});

test('AC3: clicking Activate on a SHADOW proposal moves it to ACTIVE and it is no longer actionable from the queue', async ({ page }) => {
  // promoteShadowRule requires a passing rule_backtest scoped to the REAL new
  // SHADOW rule_version id from AC2, not the original PROPOSED id.
  await pool.query(
    `INSERT INTO rule_backtest (client_id, rule_version_id, corpus_hash, passed, pass_count, regression_count)
     VALUES ($1, $2, $3, true, 1, 0)`,
    [DEV_CLIENT_ID, shadowRuleVersionId, SLUG.padEnd(64, '1').slice(0, 64)],
  );

  await page.goto('/');
  const queue = page.getByTestId('rule-proposal-queue');
  // A real, pre-existing quirk found here: GET /api/rules/proposals filters
  // only on lifecycle_state IN ('PROPOSED','SHADOW'), with no filter on
  // whether a row has since been superseded (predecessor_rule_version_id
  // pointed at by a newer row) -- so after a reload, the original PROPOSED
  // row from AC1/AC2 is STILL present alongside the new SHADOW row, as a
  // permanent "ghost" duplicate for the same rule/slug. Scoping this
  // locator to the SHADOW-labeled row specifically (not just the slug) is
  // what makes this assertion target the right one; the stale PROPOSED
  // ghost is disclosed in the PR body as a real finding, out of scope to
  // fix for an e2e-coverage task.
  // Case-SENSITIVE regexes, not plain strings: the button label "Ratify to
  // shadow" (lowercase) would otherwise case-insensitively match a plain
  // 'SHADOW' string filter too, defeating the disambiguation.
  const shadowRow = queue.locator('div').filter({ hasText: SLUG }).filter({ hasText: /SHADOW/ });
  await expect(shadowRow).toBeVisible();

  const activatePost = page.waitForResponse((res) => res.url().includes(`/api/rules/${shadowRuleVersionId}/activate`) && res.request().method() === 'POST');
  await shadowRow.getByRole('button', { name: 'Activate' }).click();
  const activateResponse = await activatePost;
  expect(activateResponse.status()).toBe(201);
  const activateBody = await activateResponse.json() as { ruleVersionId: string; created: boolean };

  const activeRow = await pool.query<{ lifecycle_state: string }>(`SELECT lifecycle_state FROM rule_version WHERE id = $1`, [activateBody.ruleVersionId]);
  expect(activeRow.rows[0]!.lifecycle_state).toBe('ACTIVE');

  // The now-ACTIVE row is no longer actionable: GET /api/rules/proposals
  // only ever returns PROPOSED/SHADOW rows, and the local onRatified patch
  // filters an ACTIVE transition out of the visible list too -- the
  // SHADOW-labeled row specifically is gone (the stale PROPOSED ghost from
  // the quirk above is a separate, pre-existing row this AC says nothing
  // about, so it is deliberately not asserted on here).
  await expect(queue.locator('div').filter({ hasText: SLUG }).filter({ hasText: /SHADOW/ })).toHaveCount(0);
  await expect(queue.locator('div').filter({ hasText: SLUG }).filter({ hasText: /ACTIVE/ })).toHaveCount(0);
});
