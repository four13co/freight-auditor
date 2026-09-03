import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DEV_CLIENT_ID, DEV_USER_ID } from '../../../scripts/seed-dev-tenant.mjs';
import { withTenantTx } from '../../../src/db/tenant-context.js';
import { generateHoldDecision } from '../../../src/modules/payments/generate-hold-decision.js';

// 86e33qzkq: full-stack e2e for PaymentApprovalQueue.tsx's real
// approve/hold flow -- real Fastify server + real Postgres, no route
// mocking. Per Bridge's 3-step P7 e2e policy: Approve has a real UI button
// -> verified through a real browser click; Hold has a fully real backend
// (PAYMENT_AUTHORIZATION_ACTIONS = approve|hold) but no UI trigger
// (PaymentApprovalQueue.tsx's own doc comment: "Only offers Approve,
// deliberately") -> driven directly via the Playwright `request` fixture,
// the same mixed-transport pattern P7.A.1 established.
//
// Blocked on 86e33t12f (fixed, merged) until this task's own second bounce:
// authorize-payment.ts validates clientId with strict z.uuid(), which the
// old DEV_CLIENT_ID sentinel failed -- a real analyst clicking Approve under
// standard dev auth 500'd. Now that the fixture UUIDs are RFC4122-compliant,
// this task's real UI/API path is genuinely reachable.
//
// Seeding: a pending payment authorization is a SCORED audit run with a
// 'hold' payment_gate_decision and no later resolving decision
// (list-pending-payment-authorizations.ts). generateHoldDecision is called
// in-process (same "seed the non-HTTP precondition directly, drive the real
// transition over real HTTP" pattern P7.A.3/P7.A.4 established) -- this
// mirrors P4.B.2's real production flow (SCORED -> system generates the
// default hold -> analyst later resolves it), not a shortcut around it.
//
// Both seeded invoices use plain, non-fixture-matching charge codes/carrier
// so they resolve to the no-contract STANDARD_RUBRIC path (CONFORMED on
// every criterion, same as GOLDEN_210 under audit-run-creation.fullstack.
// spec.ts's own note) -- payment authorization is orthogonal to whether an
// audit run has findings, so no variance is needed here.

const edi210 = (invoiceNumber: string, total: string) =>
  'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *260703*1200*U*00401*000000030*0*P*>~' +
  'GS*IM*SENDER*RECEIVER*20260703*1200*30*X*004010~' +
  'ST*210*0030~' +
  `B3**${invoiceNumber}*SHIP-P7C1****${total}****ABCD~` +
  `L1*1***${total}****400****Linehaul~` +
  'SE*4*0030~';

const INVOICE_APPROVE = `INV-P7C1-A-${Date.now()}`;
const INVOICE_HOLD = `INV-P7C1-H-${Date.now()}`;

let pool: pg.Pool;
let approveAuditRunId: string;
let holdAuditRunId: string;
const seededInvoiceIds: string[] = [];

async function seedScoredRun(request: import('@playwright/test').APIRequestContext, invoiceNumber: string, total: string): Promise<string> {
  const post = await request.post('/api/audit-runs', {
    headers: { 'x-client-id': DEV_CLIENT_ID, 'x-user-id': DEV_USER_ID, 'content-type': 'application/edi-x12' },
    data: edi210(invoiceNumber, total),
  });
  if (post.status() !== 201) {
    throw new Error(`payment-approval-queue.fullstack.spec: seed audit-run POST for ${invoiceNumber} failed with ${post.status()}`);
  }
  const body = await post.json() as { id: string; outcome: string };
  if (body.outcome !== 'SCORED') {
    throw new Error(`payment-approval-queue.fullstack.spec: expected SCORED for ${invoiceNumber}, got ${body.outcome}`);
  }
  const invoiceRow = await pool.query<{ invoice_id: string }>(`SELECT invoice_id FROM audit_run WHERE id = $1`, [body.id]);
  seededInvoiceIds.push(invoiceRow.rows[0]!.invoice_id);
  return body.id;
}

test.use({ viewport: { width: 1600, height: 1400 } });

test.beforeAll(async ({ request }) => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  approveAuditRunId = await seedScoredRun(request, INVOICE_APPROVE, '500.00');
  holdAuditRunId = await seedScoredRun(request, INVOICE_HOLD, '750.00');

  // Sequential, not Promise.all -- a single pg client cannot run two
  // concurrent queries (86e33t7yu's own root-cause class, PR #315).
  await withTenantTx({ clientIds: [DEV_CLIENT_ID], internal: true }, async (client) => {
    await generateHoldDecision(client, { clientId: DEV_CLIENT_ID, auditRunId: approveAuditRunId });
  });
  await withTenantTx({ clientIds: [DEV_CLIENT_ID], internal: true }, async (client) => {
    await generateHoldDecision(client, { clientId: DEV_CLIENT_ID, auditRunId: holdAuditRunId });
  });
});

test.afterAll(async () => {
  for (const auditRunId of [approveAuditRunId, holdAuditRunId]) {
    await pool.query(`DELETE FROM payment_gate_decision WHERE audit_run_id = $1`, [auditRunId]);
    await pool.query(`DELETE FROM audit_event WHERE detail->>'auditRunId' = $1`, [auditRunId]);
    await pool.query(`DELETE FROM audit_replay_manifest WHERE audit_run_id = $1`, [auditRunId]);
    // The no-contract STANDARD_RUBRIC path still evaluates every criterion
    // and records a per-charge charge_finding/variance_finding/scorecard row
    // each -- payment authorization is orthogonal to findings, but these
    // rows still exist and must clear before audit_run.
    await pool.query(`DELETE FROM charge_finding WHERE audit_run_id = $1`, [auditRunId]);
    await pool.query(`DELETE FROM variance_finding WHERE audit_run_id = $1`, [auditRunId]);
    await pool.query(`DELETE FROM scorecard WHERE audit_run_id = $1`, [auditRunId]);
    await pool.query(`DELETE FROM audit_run WHERE id = $1`, [auditRunId]);
  }
  for (const invoiceId of seededInvoiceIds) {
    await pool.query(`DELETE FROM charge_fact WHERE invoice_id = $1`, [invoiceId]);
    await pool.query(`DELETE FROM invoice WHERE id = $1`, [invoiceId]);
  }
  await pool.end();
});

test('AC1: seeded pending payment authorizations appear with invoice number, carrier name, and age visible', async ({ page }) => {
  await page.goto('/');

  const queue = page.getByTestId('payment-approval-queue');
  await expect(queue).toBeVisible();

  const approveRow = queue.locator('div').filter({ hasText: INVOICE_APPROVE });
  const holdRow = queue.locator('div').filter({ hasText: INVOICE_HOLD });
  await expect(approveRow).toBeVisible();
  await expect(holdRow).toBeVisible();
  // No amount field exists on PendingPaymentAuthorizationRow -- the row
  // renders invoice number, carrier name (em dash when null, as here --
  // this fixture's EDI carries no carrier match), and age only. Assert the
  // row's full text is exactly those three fields plus the Approve button,
  // not just a non-containment check that would pass even if an amount
  // field existed under a different string shape.
  const approveRowText = (await approveRow.innerText()).replace(/\s+/g, ' ').trim();
  expect(approveRowText).toBe(`${INVOICE_APPROVE} — 0d Approve`);
});

test('AC2: clicking Approve in the real Payment Approval Queue UI records the decision as approve, not just absence from the list', async ({ page }) => {
  await page.goto('/');

  const queue = page.getByTestId('payment-approval-queue');
  const approveRow = queue.locator('div').filter({ hasText: INVOICE_APPROVE });
  await expect(approveRow).toBeVisible();

  const approvePost = page.waitForResponse((res) => res.url().includes(`/api/audit-runs/${approveAuditRunId}/payment-authorization`) && res.request().method() === 'POST');
  await approveRow.getByRole('button', { name: 'Approve' }).click();
  const approveResponse = await approvePost;
  // 201: this is the first-ever 'approve' decision for this audit run (only
  // a system 'hold' exists so far) -- authorizePayment's SELECT-then-INSERT
  // finds no existing row for this specific action and creates one.
  expect(approveResponse.status()).toBe(201);
  const approveBody = await approveResponse.json() as { action: string; decisionId: string };
  expect(approveBody.action).toBe('approve');

  await expect(queue.locator('div').filter({ hasText: INVOICE_APPROVE })).toHaveCount(0);

  // Look up by audit_run_id, not by the id the response just handed back --
  // a lookup keyed on approveBody.decisionId can only confirm the endpoint's
  // own return value agrees with itself. This is the assertion the task's
  // own Rabbit-holes line asks for: prove the actual decision recorded, not
  // just that a row vanished from the queue (a short_pay/do_not_pay
  // resolution would also make the row disappear).
  const decisions = await pool.query<{ action: string; actor_kind: string }>(
    `SELECT action, actor_kind FROM payment_gate_decision WHERE audit_run_id = $1 ORDER BY action`,
    [approveAuditRunId],
  );
  expect(decisions.rows).toEqual([
    { action: 'approve', actor_kind: 'analyst' },
    { action: 'hold', actor_kind: 'system' },
  ]);
});

test('AC3: holding via a direct API call (no UI trigger exists) keeps the run pending and records the decision as hold, not approve', async ({ page, request }) => {
  await page.goto('/');
  const queue = page.getByTestId('payment-approval-queue');
  const holdRow = queue.locator('div').filter({ hasText: INVOICE_HOLD });
  await expect(holdRow).toBeVisible();
  // No 'Hold' button exists anywhere on this queue -- confirmed via
  // PaymentApprovalQueue.tsx's own doc comment and full file; this is the
  // whole reason AC3 is driven via direct HTTP instead.
  await expect(holdRow.getByRole('button', { name: 'Hold' })).toHaveCount(0);

  const holdResponse = await request.post(`/api/audit-runs/${holdAuditRunId}/payment-authorization`, {
    headers: { 'x-client-id': DEV_CLIENT_ID, 'x-user-id': DEV_USER_ID, 'content-type': 'application/json' },
    data: { action: 'hold', rationale: 'Analyst confirms hold pending further review' },
  });
  expect(holdResponse.status()).toBe(200);
  const holdBody = await holdResponse.json() as { action: string; decisionId: string };
  expect(holdBody.action).toBe('hold');

  const decision = await pool.query<{ action: string }>(`SELECT action FROM payment_gate_decision WHERE id = $1`, [holdBody.decisionId]);
  expect(decision.rows[0]!.action).toBe('hold');

  await page.reload();
  await expect(page.getByTestId('payment-approval-queue').locator('div').filter({ hasText: INVOICE_HOLD })).toBeVisible();
});
