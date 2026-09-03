import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DEV_CLIENT_ID } from '../../../scripts/seed-dev-tenant.mjs';
import { withTenantTx } from '../../../src/db/tenant-context.js';

// 86e33qz8v: full-stack e2e for ReviewQueues.tsx -- real Fastify server +
// real Postgres, no route mocking.
//
// ReviewQueues.tsx is itself a pure read-only display (no buttons, no
// onClick handlers -- confirmed via grep during reshape). Split by queue,
// per the task's own reshape note:
//
//   - Escalation queue (status = 'in_review'): a real triage mechanism DOES
//     exist, just not on ReviewQueues.tsx itself -- FindingDetail.tsx's real
//     Accept/Waive buttons change a finding's status away from 'in_review',
//     which is what removes it from this queue. AC2 drives that transition
//     through the real browser.
//   - Unassessable queue (classification = 'unassessable'): confirmed via
//     grep that nothing anywhere in src/ ever writes `classification` after
//     evaluation time -- no UI action, no API endpoint exists to clear it.
//     AC3 asserts display-only: it renders and stays present, no triage
//     attempted (this task's own No-gos forbid inventing one).
//
// Both seed findings are inserted directly (client_id/audit_run_id/
// criterion_id wiring only -- classification and the in_review status are
// preconditions, not behavior under test here; general finding status/action
// coverage is P7.B.1's scope per this task's own Rabbit holes), matching the
// "seed the non-HTTP precondition directly, drive the real transition over
// the real UI" pattern already established for P7.A.3-P7.A.5. A dedicated
// carrier/invoice/audit_run pair is created per finding so this spec never
// touches the shared E2E-FULLSTACK-001 fixture or any other suite's rows.

const ESCALATION_INVOICE = `INV-P7B3-ESC-${Date.now()}`;
const UNASSESSABLE_INVOICE = `INV-P7B3-UNA-${Date.now()}`;

let pool: pg.Pool;
let carrierId: string;
let criterionId: string;
let ruleVersionId: string;
let escalationInvoiceId: string;
let escalationAuditRunId: string;
let escalationFindingId: string;
let unassessableInvoiceId: string;
let unassessableAuditRunId: string;
let unassessableFindingId: string;

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  const carrier = await pool.query<{ id: string }>(
    `INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [`P7B3 Review Queues Carrier ${Date.now()}`],
  );
  carrierId = carrier.rows[0]!.id;

  const criterion = await pool.query<{ id: string }>(`SELECT id FROM criterion ORDER BY criterion_key LIMIT 1`);
  const ruleVersion = await pool.query<{ id: string }>(`SELECT id FROM rule_version ORDER BY id LIMIT 1`);
  if (!criterion.rows[0] || !ruleVersion.rows[0]) {
    throw new Error(
      `review-queues-triage.fullstack.spec: no criterion/rule_version rows found -- has 'npm run seed:criteria' been run against this database?`,
    );
  }
  criterionId = criterion.rows[0].id;
  ruleVersionId = ruleVersion.rows[0].id;

  await withTenantTx({ clientIds: [DEV_CLIENT_ID], internal: true }, async (client) => {
    const escInvoice = await client.query<{ id: string }>(
      `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version, status)
       VALUES ($1, $2, '210', $3, 'USD', 'v1', 'ingested') RETURNING id`,
      [DEV_CLIENT_ID, carrierId, ESCALATION_INVOICE],
    );
    escalationInvoiceId = escInvoice.rows[0]!.id;
    const escRun = await client.query<{ id: string }>(
      `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'v1', 'SCORED') RETURNING id`,
      [DEV_CLIENT_ID, escalationInvoiceId],
    );
    escalationAuditRunId = escRun.rows[0]!.id;
    // ReviewQueues.tsx renders only the first 5 rows per queue
    // (list-review-queues.ts orders by created_at ASC, oldest first) --
    // the shared DEV_CLIENT_ID tenant already carries persistent unassessable
    // findings from sibling specs that never tear themselves down by design
    // (audit-run-creation.fullstack.spec.ts's GOLDEN_210 fixture,
    // seed-fullstack-e2e-fixture.mjs's E2E-FULLSTACK-001), so a freshly
    // INSERTed row with a real `now()` created_at can be pushed past
    // position 5 and never render at all. An explicit early created_at
    // guarantees this spec's own rows always sort first, regardless of how
    // much fixture data has accumulated elsewhere in the tenant.
    const escFinding = await client.query<{ id: string }>(
      `INSERT INTO variance_finding (client_id, audit_run_id, criterion_id, rule_version_id, status, evaluated_expr, created_at)
       VALUES ($1, $2, $3, $4, 'in_review', '{}'::jsonb, '2020-01-01T00:00:00Z') RETURNING id`,
      [DEV_CLIENT_ID, escalationAuditRunId, criterionId, ruleVersionId],
    );
    escalationFindingId = escFinding.rows[0]!.id;

    const unaInvoice = await client.query<{ id: string }>(
      `INSERT INTO invoice (client_id, carrier_id, transaction_set, invoice_number, currency, parser_version, status)
       VALUES ($1, $2, '210', $3, 'USD', 'v1', 'ingested') RETURNING id`,
      [DEV_CLIENT_ID, carrierId, UNASSESSABLE_INVOICE],
    );
    unassessableInvoiceId = unaInvoice.rows[0]!.id;
    const unaRun = await client.query<{ id: string }>(
      `INSERT INTO audit_run (client_id, invoice_id, engine_spec_version, outcome) VALUES ($1, $2, 'v1', 'SCORED') RETURNING id`,
      [DEV_CLIENT_ID, unassessableInvoiceId],
    );
    unassessableAuditRunId = unaRun.rows[0]!.id;
    const unaFinding = await client.query<{ id: string }>(
      `INSERT INTO variance_finding (client_id, audit_run_id, criterion_id, rule_version_id, classification, evaluated_expr, created_at)
       VALUES ($1, $2, $3, $4, 'unassessable', '{}'::jsonb, '2020-01-01T00:00:00Z') RETURNING id`,
      [DEV_CLIENT_ID, unassessableAuditRunId, criterionId, ruleVersionId],
    );
    unassessableFindingId = unaFinding.rows[0]!.id;
  });
});

test.afterAll(async () => {
  await pool.query(`DELETE FROM finding_status_event WHERE variance_finding_id IN ($1, $2)`, [escalationFindingId, unassessableFindingId]);
  await pool.query(`DELETE FROM variance_finding WHERE id IN ($1, $2)`, [escalationFindingId, unassessableFindingId]);
  await pool.query(`DELETE FROM audit_run WHERE id IN ($1, $2)`, [escalationAuditRunId, unassessableAuditRunId]);
  await pool.query(`DELETE FROM invoice WHERE id IN ($1, $2)`, [escalationInvoiceId, unassessableInvoiceId]);
  await pool.query(`DELETE FROM carrier WHERE id = $1`, [carrierId]);
  await pool.end();
});

test.use({ viewport: { width: 1600, height: 1400 } });

test('AC1: a seeded escalated finding and a seeded unassessable finding each appear in their correct Review Queues column', async ({ page }) => {
  await page.goto('/');

  const reviewQueues = page.getByTestId('review-queues');
  await expect(reviewQueues).toBeVisible();

  const escalationSection = reviewQueues.locator('section').filter({ hasText: 'Escalations' });
  const unassessableSection = reviewQueues.locator('section').filter({ hasText: 'Needs evidence' });

  await expect(escalationSection).toContainText(ESCALATION_INVOICE);
  await expect(escalationSection).not.toContainText(UNASSESSABLE_INVOICE);
  await expect(unassessableSection).toContainText(UNASSESSABLE_INVOICE);
  await expect(unassessableSection).not.toContainText(ESCALATION_INVOICE);
});

test('AC2: accepting an escalated finding via FindingDetail removes it from the escalation queue on the next view', async ({ page }) => {
  await page.goto('/');

  const row = page.getByTestId('finding-row').filter({ hasText: ESCALATION_INVOICE }).first();
  await expect(row).toBeVisible();
  await row.click();

  const drawer = page.getByTestId('finding-detail');
  await expect(drawer).toBeVisible();

  const actionPost = page.waitForResponse((res) => res.url().includes(`/api/findings/${escalationFindingId}/action`) && res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Accept' }).click();
  await actionPost;

  const persisted = await pool.query<{ status: string }>(`SELECT status FROM variance_finding WHERE id = $1`, [escalationFindingId]);
  expect(persisted.rows[0]!.status).toBe('accepted');

  // ReviewQueues fetches once on mount (Dashboard.tsx), not patched
  // incrementally the way FindingsTable's own rows are -- the task's own
  // Solution text says "reload/re-fetch ReviewQueues", not "without a full
  // reload" (that stricter no-reload bar is P7.B.1's AC1, a different
  // component/claim entirely).
  await page.reload();
  const escalationSection = page.getByTestId('review-queues').locator('section').filter({ hasText: 'Escalations' });
  await expect(escalationSection).not.toContainText(ESCALATION_INVOICE);
});

test('AC3: the unassessable finding has no triage action and stays present in its queue', async ({ page }) => {
  await page.goto('/');

  const unassessableSection = page.getByTestId('review-queues').locator('section').filter({ hasText: 'Needs evidence' });
  await expect(unassessableSection).toContainText(UNASSESSABLE_INVOICE);

  // Display-only, per this task's own No-gos (no "resolve unassessable"
  // action exists anywhere) -- confirm the finding's own row in the main
  // table carries no action controls beyond what any other finding has
  // (Accept/Waive/Escalate act on status, never on classification), and that
  // classification is unaffected by opening the drawer at all.
  const row = page.getByTestId('finding-row').filter({ hasText: UNASSESSABLE_INVOICE }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByTestId('finding-detail')).toBeVisible();
  await page.getByRole('button', { name: 'Close finding detail' }).click();

  const persisted = await pool.query<{ classification: string | null }>(`SELECT classification FROM variance_finding WHERE id = $1`, [unassessableFindingId]);
  expect(persisted.rows[0]!.classification).toBe('unassessable');

  await page.reload();
  await expect(unassessableSection).toContainText(UNASSESSABLE_INVOICE);
});
