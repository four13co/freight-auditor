import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DEV_CLIENT_ID, DEV_USER_ID } from '../../../scripts/seed-dev-tenant.mjs';
import { FIXTURE_CARRIER_NAME } from '../../../scripts/seed-fullstack-e2e-fixture.mjs';

// 86e33qz8c: full-stack e2e for the core analyst review loop -- status
// change and gating action go through the real Dashboard FindingsTable /
// FindingDetail drawer (real server + real Postgres, no mocking); reversal
// (AC3) has no UI trigger anywhere in web/src (confirmed via grep -- same
// missing-UI class as P7.A.1/P7.A.4's investigations), so it's driven
// directly via POST /api/findings/:id/reverse through Playwright's `request`
// fixture instead, noted here and in the PR body per that established
// precedent.
//
// Scope-honesty note (Rabbit holes says not to assert ledger internals, but
// this goes one step further and is worth stating explicitly): AC3's own
// text says a reversal makes "the finding return[] to its pre-action state."
// recordHumanOverrideReversal (src/modules/rule-engine/record-human-override-reversal.ts)
// never writes to variance_finding.status -- reversal is purely a
// human_override/rule-quarantine bookkeeping concern, orthogonal to the
// finding's own status column. This spec proves what the endpoint actually
// does (succeeds, is durably recorded, is never silently dropped) and does
// NOT assert a status reversion that the real implementation doesn't perform.
//
// A fresh, dedicated invoice/finding is seeded (not the shared
// E2E-FULLSTACK-001 fixture dashboard.fullstack.spec.ts also reads) so this
// spec's write path (status/action/reversal) can never mutate state another
// suite's assertions depend on.

const CONTRACT_INVOICE_NUMBER = 'INV-P7B1-001';

const EDI_210 =
  'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *260703*1200*U*00401*000000010*0*P*>~' +
  'GS*IM*SENDER*RECEIVER*20260703*1200*10*X*004010~' +
  'ST*210*0010~' +
  `B3**${CONTRACT_INVOICE_NUMBER}*SHIP-P7B1-001****1250.00****ABCD~` +
  'L1*1***1000.00****400****Linehaul~' +
  'L1*2***250.00****405****Fuel Surcharge~' +
  'SE*5*0010~';

let pool: pg.Pool;
let auditRunId: string;
let invoiceId: string;
let findingId: string;
let criterionId: string;
let ruleVersionId: string;

test.beforeAll(async ({ request }) => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  const contractVersion = await pool.query<{ id: string }>(
    `SELECT cv.id FROM contract_version cv
     JOIN contract c ON c.id = cv.contract_id
     JOIN carrier ca ON ca.id = c.carrier_id
     WHERE ca.name = $1 AND cv.client_id = $2
     ORDER BY cv.id LIMIT 1`,
    [FIXTURE_CARRIER_NAME, DEV_CLIENT_ID],
  );
  if (!contractVersion.rows[0]) {
    throw new Error(
      `finding-review-lifecycle.fullstack.spec: no contract_version found for carrier "${FIXTURE_CARRIER_NAME}" / ` +
        `client ${DEV_CLIENT_ID} -- has 'npm run seed:e2e-fullstack-fixture' been run against this database?`,
    );
  }

  const post = await request.post(`/api/audit-runs?contract_version_id=${contractVersion.rows[0].id}`, {
    headers: { 'x-client-id': DEV_CLIENT_ID, 'x-user-id': DEV_USER_ID, 'content-type': 'application/edi-x12' },
    data: EDI_210,
  });
  if (post.status() !== 201) {
    throw new Error(`finding-review-lifecycle.fullstack.spec: seed audit-run POST failed with ${post.status()}`);
  }
  auditRunId = (await post.json() as { id: string }).id;

  // Scoped to THIS run's own audit_run_id, not just the invoice number -- a
  // non-torn-down local rerun submits the same invoice number again (no
  // idempotency guard on a bare upload, same as audit-run-creation.fullstack.spec.ts's
  // own documented caveat) and would otherwise risk grabbing a stale finding
  // from an earlier run.
  const row = await pool.query<{ id: string; criterion_id: string; rule_version_id: string }>(
    `SELECT id, criterion_id, rule_version_id FROM variance_finding WHERE audit_run_id = $1 AND direction = 'OVERCHARGE'`,
    [auditRunId],
  );
  if (!row.rows[0]) {
    throw new Error(`finding-review-lifecycle.fullstack.spec: no OVERCHARGE finding was derived for ${CONTRACT_INVOICE_NUMBER}`);
  }
  findingId = row.rows[0].id;
  criterionId = row.rows[0].criterion_id;
  ruleVersionId = row.rows[0].rule_version_id;

  const auditRunRow = await pool.query<{ invoice_id: string }>(`SELECT invoice_id FROM audit_run WHERE id = $1`, [auditRunId]);
  invoiceId = auditRunRow.rows[0]!.invoice_id;

  // resolvePromotionPolicy (src/modules/rule-engine/promotion-policy.ts) throws
  // if no row matches -- a freshly migrated+seeded DB has none at all (no
  // global default is ever seeded), so the reverse endpoint 500s without
  // this. Existing DB tests (test/db/record-human-override-reversal.db.test.ts)
  // seed their own client-scoped row the same way rather than relying on a
  // global default; mirrored here, scoped to DEV_CLIENT_ID.
  await pool.query(
    `INSERT INTO promotion_policy (client_id, rule_type, max_reversals) VALUES ($1, 'CONTRACT_CONFORMANCE', 5)`,
    [DEV_CLIENT_ID],
  );
});

test.afterAll(async () => {
  // Scoped to THIS spec's own auditRunId/invoiceId, never the shared
  // DEV_CLIENT_ID's other rows (e.g. seed-fullstack-e2e-fixture.mjs's own
  // E2E-FULLSTACK-001 fixture) -- last round's finding (86e33qyxp) left an
  // uncleaned invoice_draft that broke a sibling test:db file's own
  // client-scoped cleanup via a foreign-key violation; this spec's status
  // change (AC1) writes finding_status_event rows the same way, so the fix
  // this time is a full, precisely-scoped teardown rather than a partial one.
  const sourceDocument = await pool.query<{ source_document_id: string | null }>(
    `SELECT source_document_id FROM charge_finding WHERE audit_run_id = $1 AND source_document_id IS NOT NULL LIMIT 1`,
    [auditRunId],
  );
  await pool.query(`DELETE FROM finding_status_event WHERE variance_finding_id IN (SELECT id FROM variance_finding WHERE audit_run_id = $1)`, [auditRunId]);
  await pool.query(`DELETE FROM human_override WHERE client_id = $1 AND criterion_id = $2`, [DEV_CLIENT_ID, criterionId]);
  await pool.query(`DELETE FROM promotion_policy WHERE client_id = $1 AND rule_type = 'CONTRACT_CONFORMANCE'`, [DEV_CLIENT_ID]);
  await pool.query(`DELETE FROM scorecard WHERE audit_run_id = $1`, [auditRunId]);
  await pool.query(`DELETE FROM charge_finding WHERE audit_run_id = $1`, [auditRunId]);
  await pool.query(`DELETE FROM gate_failure WHERE audit_run_id = $1`, [auditRunId]);
  await pool.query(`DELETE FROM variance_finding WHERE audit_run_id = $1`, [auditRunId]);
  await pool.query(`DELETE FROM charge_fact WHERE invoice_id = $1`, [invoiceId]);
  await pool.query(`DELETE FROM audit_replay_manifest WHERE audit_run_id = $1`, [auditRunId]);
  await pool.query(`DELETE FROM audit_run WHERE id = $1`, [auditRunId]);
  await pool.query(`DELETE FROM invoice WHERE id = $1`, [invoiceId]);
  if (sourceDocument.rows[0]?.source_document_id) {
    await pool.query(`DELETE FROM source_document WHERE id = $1`, [sourceDocument.rows[0].source_document_id]);
  }
  await pool.end();
});

test.use({ viewport: { width: 1600, height: 1400 } });

test('AC1+AC2: status change and a gating action both go through the real Dashboard, no full reload', async ({ page }) => {
  await page.goto('/');

  // CONTRACT_RUBRIC evaluates multiple criteria per invoice -- every finding
  // row (conformed and variance alike) shares the invoice number, so this
  // narrows to the one genuine OVERCHARGE row, same disambiguation
  // audit-run-creation.fullstack.spec.ts already uses.
  // .first(): same non-torn-down-local-rerun caveat as beforeAll's own note
  // above -- a rerun renders more than one matching row, and this AC only
  // needs one of them to be genuinely interactive.
  const row = page.getByTestId('finding-row').filter({ hasText: CONTRACT_INVOICE_NUMBER }).filter({ hasText: '$100.00' }).first();
  await expect(row).toBeVisible();
  // Dashboard stacks eight panels above FindingsTable inside a
  // `min-h-0 flex-1 overflow-y-auto` layout with FindingsTable's own nested
  // `overflow-auto` region -- at the default 1280x720 viewport that nested
  // region can collapse to near-zero painted height (rows still report
  // "visible" in the DOM, but their computed click point falls on an
  // ancestor). A taller viewport (test.use above) is the real fix, not a
  // click-targeting workaround.
  await row.click();

  const drawer = page.getByTestId('finding-detail');
  await expect(drawer).toBeVisible();

  // AC1: status change via PATCH /api/findings/:id/status, reflected in the
  // drawer's own select without a page reload. handleStatusSelect
  // (FindingDetail.tsx) updates the select's value optimistically BEFORE the
  // PATCH resolves, so toHaveValue alone would pass before the write lands --
  // wait for the actual response before asserting persisted DB state.
  const statusSelect = page.getByLabel('Finding status');
  await expect(statusSelect).toHaveValue('open');
  const statusPatch = page.waitForResponse((res) => res.url().includes(`/api/findings/${findingId}/status`) && res.request().method() === 'PATCH');
  await statusSelect.selectOption('queued_for_dispute');
  await statusPatch;
  await expect(statusSelect).toHaveValue('queued_for_dispute');

  const persistedAfterStatus = await pool.query<{ status: string }>(`SELECT status FROM variance_finding WHERE id = $1`, [findingId]);
  expect(persistedAfterStatus.rows[0]!.status).toBe('queued_for_dispute');

  // AC2: a gating action (accept) via POST /api/findings/:id/action --
  // distinct target status from AC1's, so each transition is unambiguous.
  // applyFindingAction only updates the drawer's state from the RESOLVED
  // response (not optimistically), so waiting on the click here isn't
  // strictly required for read-after-write correctness the way AC1's
  // optimistic update was -- waited anyway for consistency and to avoid a
  // race on the immediately-following DB read.
  const actionPost = page.waitForResponse((res) => res.url().includes(`/api/findings/${findingId}/action`) && res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Accept' }).click();
  await actionPost;
  await expect(statusSelect).toHaveValue('accepted');

  const persistedAfterAction = await pool.query<{ status: string }>(`SELECT status FROM variance_finding WHERE id = $1`, [findingId]);
  expect(persistedAfterAction.rows[0]!.status).toBe('accepted');
});

test('AC3: reversing the finding is recorded durably, never silently dropped', async ({ request }) => {
  const before = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM human_override WHERE client_id = $1 AND criterion_id = $2`,
    [DEV_CLIENT_ID, criterionId],
  );

  const reverse = await request.post(`/api/findings/${findingId}/reverse`, {
    headers: { 'x-client-id': DEV_CLIENT_ID, 'x-user-id': DEV_USER_ID, 'content-type': 'application/json' },
    data: { caseFingerprint: `p7b1-${findingId}`, assertedValue: { corrected: true } },
  });
  expect(reverse.status()).toBe(201);
  const body = await reverse.json() as { id: string; humanOverrideId: string; ruleVersionId: string };
  expect(body.id).toBe(findingId);
  expect(body.humanOverrideId).toEqual(expect.any(String));
  expect(body.ruleVersionId).toBe(ruleVersionId);

  const after = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM human_override WHERE client_id = $1 AND criterion_id = $2`,
    [DEV_CLIENT_ID, criterionId],
  );
  expect(after.rows[0]!.n).toBe(before.rows[0]!.n + 1);

  const overrideRow = await pool.query<{ id: string; reversal_count: number }>(
    `SELECT id, reversal_count FROM human_override WHERE id = $1`,
    [body.humanOverrideId],
  );
  expect(overrideRow.rows[0]!.reversal_count).toBe(1);
});
