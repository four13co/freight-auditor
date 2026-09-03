import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DEV_CLIENT_ID, DEV_USER_ID } from '../../../scripts/seed-dev-tenant.mjs';

// 86e33qz8k: full-stack e2e for the Gate Failures panel -- real Fastify
// server + real Postgres, no route mocking.
//
// Scope-honesty note on AC2: its own text says a gate-failure entry, when
// clicked, "navigates to the correct underlying finding, not a mismatched
// one." GateFailuresPanel.tsx has no such navigation -- clicking a row
// toggles an inline accordion (`gate-kickback-review`) revealing more of
// THAT SAME row's own fields (criterionKey, clause, evidence). There is no
// separate "finding" to navigate to: a gate-failed invoice is REJECTED_REWORK
// -- kicked back before scoring, so it never produces a variance_finding row
// at all (GateFailuresPanel.tsx's own doc comment says exactly this, and
// GateFailureRow, web/src/lib/api.ts:79-92, carries no findingId field).
// What this spec proves instead -- the real content of the AC's guarantee --
// is that clicking one gate failure reveals THAT failure's own detail, never
// a different row's: two distinct gate failures are seeded, and each row's
// expanded panel is asserted to be scoped to that row alone.

const EDI_A = (invoiceNumber: string, declaredTotal: string, lineAmount: string) =>
  'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *260703*1200*U*00401*000000020*0*P*>~' +
  'GS*IM*SENDER*RECEIVER*20260703*1200*20*X*004010~' +
  'ST*210*0020~' +
  `B3**${invoiceNumber}*SHIP-P7B2****${declaredTotal}****ABCD~` +
  `L1*1***${lineAmount}****400****Linehaul~` +
  'SE*4*0020~';

const INVOICE_A = 'INV-P7B2-001';
const INVOICE_B = 'INV-P7B2-002';

let pool: pg.Pool;
const seededAuditRunIds: string[] = [];
const seededInvoiceIds: string[] = [];

async function seedGateFailure(request: import('@playwright/test').APIRequestContext, invoiceNumber: string, declaredTotal: string, lineAmount: string) {
  const post = await request.post('/api/audit-runs', {
    headers: { 'x-client-id': DEV_CLIENT_ID, 'x-user-id': DEV_USER_ID, 'content-type': 'application/edi-x12' },
    data: EDI_A(invoiceNumber, declaredTotal, lineAmount),
  });
  if (post.status() !== 201) {
    throw new Error(`gate-failures-panel.fullstack.spec: seed audit-run POST for ${invoiceNumber} failed with ${post.status()}`);
  }
  const body = await post.json() as { id: string; outcome: string };
  if (body.outcome !== 'REJECTED_REWORK') {
    throw new Error(`gate-failures-panel.fullstack.spec: expected REJECTED_REWORK for ${invoiceNumber}, got ${body.outcome}`);
  }
  seededAuditRunIds.push(body.id);
  const invoiceRow = await pool.query<{ invoice_id: string }>(`SELECT invoice_id FROM audit_run WHERE id = $1`, [body.id]);
  seededInvoiceIds.push(invoiceRow.rows[0]!.invoice_id);
}

test.use({ viewport: { width: 1600, height: 1400 } });

test.beforeAll(async ({ request }) => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await seedGateFailure(request, INVOICE_A, '1250.00', '1050.00');
  await seedGateFailure(request, INVOICE_B, '900.00', '800.00');
});

test.afterAll(async () => {
  // Dependency-ordered teardown scoped to this spec's own audit_run_ids/
  // invoice_ids only -- never the shared DEV_CLIENT_ID's other fixture rows.
  for (const auditRunId of seededAuditRunIds) {
    const sourceDocument = await pool.query<{ source_document_id: string | null }>(
      `SELECT source_document_id FROM gate_failure WHERE audit_run_id = $1 AND source_document_id IS NOT NULL LIMIT 1`,
      [auditRunId],
    );
    await pool.query(`DELETE FROM gate_failure WHERE audit_run_id = $1`, [auditRunId]);
    await pool.query(`DELETE FROM audit_replay_manifest WHERE audit_run_id = $1`, [auditRunId]);
    await pool.query(`DELETE FROM audit_run WHERE id = $1`, [auditRunId]);
    if (sourceDocument.rows[0]?.source_document_id) {
      await pool.query(`DELETE FROM source_document WHERE id = $1`, [sourceDocument.rows[0].source_document_id]);
    }
  }
  for (const invoiceId of seededInvoiceIds) {
    await pool.query(`DELETE FROM invoice WHERE id = $1`, [invoiceId]);
  }
  await pool.end();
});

test('AC1: a gate-failed invoice surfaces in the Gate Failures panel with its reason visible', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByTestId('gate-failures-panel')).toBeVisible();
  const rowA = page.getByTestId('gate-failure-row').filter({ hasText: INVOICE_A });
  await expect(rowA).toBeVisible();
  // "its gate reason visible" -- the row's own defect text renders unconditionally,
  // not only after expanding.
  await expect(rowA).not.toBeEmpty();
});

test('AC2: clicking a gate failure reveals that failure\'s own detail, never a mismatched row\'s', async ({ page }) => {
  await page.goto('/');

  const rowA = page.getByTestId('gate-failure-row').filter({ hasText: INVOICE_A });
  const rowB = page.getByTestId('gate-failure-row').filter({ hasText: INVOICE_B });
  await expect(rowA).toBeVisible();
  await expect(rowB).toBeVisible();

  // Neither row's detail is expanded yet.
  await expect(rowA.getByTestId('gate-kickback-review')).toHaveCount(0);
  await expect(rowB.getByTestId('gate-kickback-review')).toHaveCount(0);

  await rowA.click();
  await expect(rowA.getByTestId('gate-kickback-review')).toBeVisible();
  // Row A's own review panel is scoped to row A -- row B's stays collapsed,
  // proving the click didn't reveal (or leak into) a different row's detail.
  await expect(rowB.getByTestId('gate-kickback-review')).toHaveCount(0);

  await rowA.click();
  await expect(rowA.getByTestId('gate-kickback-review')).toHaveCount(0);

  await rowB.click();
  await expect(rowB.getByTestId('gate-kickback-review')).toBeVisible();
  await expect(rowA.getByTestId('gate-kickback-review')).toHaveCount(0);
});
