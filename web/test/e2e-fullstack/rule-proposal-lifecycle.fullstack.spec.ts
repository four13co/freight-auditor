import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DEV_CLIENT_ID, DEV_USER_ID, DEV_USER_ID_2 } from '../../../scripts/seed-dev-tenant.mjs';

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
// transitionRuleLifecycle (src/modules/rule-engine/transition-rule-
// lifecycle.ts) never mutates a rule_version row in place -- each transition
// INSERTs a NEW immutable row (predecessor_rule_version_id linking back) and
// returns its id. AC2/AC3 below reload between them (the same "reload
// between independently-stated Given clauses" allowance already used for
// ReviewQueues' AC2, 86e33qz8v), so they don't exercise the no-reload path.
//
// 86e33t9n0 fixed two real bugs in this append-only-transition flow, found
// during this task's own build and disclosed (not fixed) in PR #311: (1)
// Dashboard.tsx's onRatified used to patch the row's lifecycle_state in
// place while keeping the OLD (now-superseded) id, so acting on that same
// row a second time without a reload would target the wrong rule_version;
// (2) GET /api/rules/proposals had no check for whether a row had since
// been superseded, so the original PROPOSED row stayed visible forever as a
// ghost duplicate after ratification. The two tests at the bottom of this
// file prove both fixes directly, against the real route/DB.
//
// 86e367r9q: Activate (SHADOW -> ACTIVE) now requires dual control -- a
// different analyst than whoever ratified the rule version -- instead of an
// unreachable rule_backtest row (see promote-shadow-rule.ts's own comment).
// The app's dev-header auth path sends a single fixed x-user-id
// (DEV_USER_ID) for every request the browser makes, so a real UI click
// alone can't vary the actor between Ratify and Activate; interceptRoleAs
// below rewrites just the Activate POST's x-user-id header to DEV_USER_ID_2
// (seeded by seed-dev-tenant.mjs) so the click genuinely runs as a second,
// distinct internal analyst -- proving the dual-control round trip through
// the real UI/route/DB with no manually-inserted rule_backtest row anywhere.

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
  await pool.query(`DELETE FROM promotion_event WHERE rule_version_id IN (SELECT id FROM rule_version WHERE rule_id = $1)`, [ruleId]);
  await pool.query(`DELETE FROM audit_event WHERE entity = 'rule_version' AND entity_id IN (SELECT id FROM rule_version WHERE rule_id = $1)`, [ruleId]);
  await pool.query(`DELETE FROM audit_event WHERE entity = 'rule_version' AND rule_version_id IN (SELECT id FROM rule_version WHERE rule_id = $1)`, [ruleId]);
  await pool.query(`DELETE FROM rule_version WHERE rule_id = $1`, [ruleId]);
  await pool.query(`DELETE FROM rule WHERE id = $1`, [ruleId]);
  await pool.end();
});

test.use({ viewport: { width: 1600, height: 1400 } });

/** Rewrites x-user-id to a second seeded internal analyst on just the Activate POST, so the click runs as a genuinely different actor than whichever one ratified. */
async function activateAsSecondAnalyst(page: import('@playwright/test').Page) {
  await page.route('**/api/rules/*/activate', async (route) => {
    await route.continue({ headers: { ...route.request().headers(), 'x-user-id': DEV_USER_ID_2 } });
  });
}

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
  // 86e367r9q: Activate now requires dual control -- a different analyst
  // than whoever ratified this rule version (AC2 above ratified as
  // DEV_USER_ID via the page's own fixed dev-header identity). Route the
  // Activate POST through DEV_USER_ID_2 so this click is genuinely a
  // different, seeded internal analyst.
  await activateAsSecondAnalyst(page);

  await page.goto('/');
  const queue = page.getByTestId('rule-proposal-queue');
  // 86e33t9n0 fixed the ghost-duplicate bug: the original PROPOSED row is no
  // longer returned once a successor exists, so after this reload exactly
  // ONE row for this slug is visible (the real SHADOW row), not two.
  await expect(queue.locator('div').filter({ hasText: SLUG })).toHaveCount(1);
  // Case-SENSITIVE regex, not a plain string: the button label "Ratify to
  // shadow" (lowercase) would otherwise case-insensitively match a plain
  // 'SHADOW' string filter too.
  const shadowRow = queue.locator('div').filter({ hasText: SLUG }).filter({ hasText: /SHADOW/ });
  await expect(shadowRow).toBeVisible();

  const rationaleInput = shadowRow.getByPlaceholder(/Activation rationale/);
  await rationaleInput.click();
  await rationaleInput.fill('Second analyst confirms activation');

  const activatePost = page.waitForResponse((res) => res.url().includes(`/api/rules/${shadowRuleVersionId}/activate`) && res.request().method() === 'POST');
  await shadowRow.getByRole('button', { name: 'Activate' }).click();
  const activateResponse = await activatePost;
  expect(activateResponse.status()).toBe(201);
  const activateBody = await activateResponse.json() as { ruleVersionId: string; created: boolean };

  const activeRow = await pool.query<{ lifecycle_state: string }>(`SELECT lifecycle_state FROM rule_version WHERE id = $1`, [activateBody.ruleVersionId]);
  expect(activeRow.rows[0]!.lifecycle_state).toBe('ACTIVE');

  // The now-ACTIVE row is no longer actionable: GET /api/rules/proposals
  // only ever returns PROPOSED/SHADOW rows, the local onRatified patch
  // filters an ACTIVE transition out of the visible list too, AND (86e33t9n0)
  // the now-superseded SHADOW row no longer ghosts the list either -- nothing
  // for this slug renders at all.
  await expect(queue.locator('div').filter({ hasText: SLUG })).toHaveCount(0);
});

test('AC (86e33t9n0): clicking Activate immediately after Ratify targets the correct, current row -- no reload', async ({ page }) => {
  const slug = `p7b5-no-reload-${Date.now()}`;
  const rule = await pool.query<{ id: string }>(`INSERT INTO rule (slug, rule_type) VALUES ($1, 'STRUCTURAL') RETURNING id`, [slug]);
  const noReloadRuleId = rule.rows[0]!.id;
  const rv = await pool.query<{ id: string }>(
    `INSERT INTO rule_version (rule_id, hardness, lifecycle_state, ast, ast_hash, emits)
     VALUES ($1, 'AI_CANON', 'PROPOSED', '{}'::jsonb, $2, 'PASS_FAIL') RETURNING id`,
    [noReloadRuleId, slug.padEnd(64, '2').slice(0, 64)],
  );
  const proposedId = rv.rows[0]!.id;

  try {
    // 86e367r9q: dual control means this click must run as a different
    // analyst than the one who just ratified (the page's own fixed
    // dev-header identity, DEV_USER_ID).
    await activateAsSecondAnalyst(page);

    await page.goto('/');
    const queue = page.getByTestId('rule-proposal-queue');
    const row = queue.locator('div').filter({ hasText: slug });
    await expect(row).toBeVisible();

    const ratifyPost = page.waitForResponse((res) => res.url().includes(`/api/rules/${proposedId}/ratify`) && res.request().method() === 'POST');
    await row.getByRole('button', { name: 'Ratify to shadow' }).click();
    const ratifyBody = await (await ratifyPost).json() as { ruleVersionId: string };
    const shadowId = ratifyBody.ruleVersionId;
    expect(shadowId).not.toBe(proposedId);
    await expect(row.getByRole('button', { name: 'Activate' })).toBeVisible();

    const rationaleInput = row.getByPlaceholder(/Activation rationale/);
    await rationaleInput.click();
    await rationaleInput.fill('Second analyst confirms activation, no reload');

    // The bug: before the fix, this click would fire against the STALE
    // pre-ratify proposedId, not the real new shadowId -- the URL assertion
    // below is what catches it. (transitionRuleLifecycle would then reject
    // that call, since proposedId's own lifecycle_state is still PROPOSED
    // in the DB -- transitions are append-only and never mutate the
    // predecessor -- and PROPOSED -> ACTIVE is not an allowed transition;
    // that specific route has no error mapping for it, so it would have
    // surfaced as an uncaught 500, not a clean 4xx.)
    const activatePost = page.waitForResponse((res) => res.url().includes('/api/rules/') && res.url().includes('/activate') && res.request().method() === 'POST');
    await row.getByRole('button', { name: 'Activate' }).click();
    const activateResponse = await activatePost;
    expect(activateResponse.url()).toContain(`/api/rules/${shadowId}/activate`);
    expect(activateResponse.status()).toBe(201);
    const activateBody = await activateResponse.json() as { ruleVersionId: string };

    const activeRow = await pool.query<{ lifecycle_state: string }>(`SELECT lifecycle_state FROM rule_version WHERE id = $1`, [activateBody.ruleVersionId]);
    expect(activeRow.rows[0]!.lifecycle_state).toBe('ACTIVE');
  } finally {
    await pool.query(`DELETE FROM promotion_event WHERE rule_version_id IN (SELECT id FROM rule_version WHERE rule_id = $1)`, [noReloadRuleId]);
    await pool.query(`DELETE FROM audit_event WHERE entity = 'rule_version' AND entity_id IN (SELECT id FROM rule_version WHERE rule_id = $1)`, [noReloadRuleId]);
    await pool.query(`DELETE FROM audit_event WHERE entity = 'rule_version' AND rule_version_id IN (SELECT id FROM rule_version WHERE rule_id = $1)`, [noReloadRuleId]);
    await pool.query(`DELETE FROM rule_version WHERE rule_id = $1`, [noReloadRuleId]);
    await pool.query(`DELETE FROM rule WHERE id = $1`, [noReloadRuleId]);
  }
});

test('AC (86e33t9n0): after ratifying, GET /api/rules/proposals no longer returns the original superseded PROPOSED row', async ({ request }) => {
  const slug = `p7b5-ghost-check-${Date.now()}`;
  const rule = await pool.query<{ id: string }>(`INSERT INTO rule (slug, rule_type) VALUES ($1, 'STRUCTURAL') RETURNING id`, [slug]);
  const ghostRuleId = rule.rows[0]!.id;
  const rv = await pool.query<{ id: string }>(
    `INSERT INTO rule_version (rule_id, hardness, lifecycle_state, ast, ast_hash, emits)
     VALUES ($1, 'AI_CANON', 'PROPOSED', '{}'::jsonb, $2, 'PASS_FAIL') RETURNING id`,
    [ghostRuleId, slug.padEnd(64, '3').slice(0, 64)],
  );
  const proposedId = rv.rows[0]!.id;

  try {
    const before = await request.get('/api/rules/proposals', { headers: { 'x-client-id': DEV_CLIENT_ID, 'x-user-id': DEV_USER_ID } });
    const beforeIds = ((await before.json()) as { proposals: { id: string }[] }).proposals.map((p) => p.id);
    expect(beforeIds).toContain(proposedId);

    const ratify = await request.post(`/api/rules/${proposedId}/ratify`, {
      headers: { 'x-client-id': DEV_CLIENT_ID, 'x-user-id': DEV_USER_ID, 'content-type': 'application/json' },
      data: { rationale: 'ghost-check ratification' },
    });
    expect(ratify.status()).toBe(201);
    const { ruleVersionId: shadowId } = (await ratify.json()) as { ruleVersionId: string };

    const after = await request.get('/api/rules/proposals', { headers: { 'x-client-id': DEV_CLIENT_ID, 'x-user-id': DEV_USER_ID } });
    const afterIds = ((await after.json()) as { proposals: { id: string }[] }).proposals.map((p) => p.id);
    expect(afterIds).not.toContain(proposedId);
    expect(afterIds).toContain(shadowId);
  } finally {
    await pool.query(`DELETE FROM promotion_event WHERE rule_version_id IN (SELECT id FROM rule_version WHERE rule_id = $1)`, [ghostRuleId]);
    await pool.query(`DELETE FROM audit_event WHERE entity = 'rule_version' AND entity_id IN (SELECT id FROM rule_version WHERE rule_id = $1)`, [ghostRuleId]);
    await pool.query(`DELETE FROM rule_version WHERE rule_id = $1`, [ghostRuleId]);
    await pool.query(`DELETE FROM rule WHERE id = $1`, [ghostRuleId]);
  }
});
