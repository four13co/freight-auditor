import { test, expect } from '@playwright/test';
import pg from 'pg';
import { loginViaForm } from './login-form.js';
import { assertSeeded } from './assert-seeded.js';
import { DEV_CLIENT_ID } from '../../../scripts/seed-dev-tenant.mjs';
import { E2E_PORTAL_EMAIL, E2E_PORTAL_PASSWORD } from '../../../scripts/seed-e2e-portal-user.mjs';
import { E2E_PORTAL_ADMIN_EMAIL, E2E_PORTAL_ADMIN_PASSWORD } from '../../../scripts/seed-e2e-portal-admin-user.mjs';
import { makeTextPdf } from '../../../test/fixtures/pdf-invoice.js';

// 86e36yj9d: full-stack e2e for the client portal's Uploads section -- real
// browser, real login (no DEV_AUTH_HEADERS), real Fastify server, real
// Postgres, same harness as portal-shell.fullstack.spec.ts (this same
// directory). AC3/AC4/AC5 all drive the actual browser upload
// (setInputFiles) through POST /api/portal/invoice-drafts -- unlike
// invoice-draft-confirm/reject.fullstack.spec.ts's own precedent (seed the
// draft in-process, since no UI existed to drive), there is no non-HTTP
// path here: the browser upload IS what these ACs prove. The real
// extraction step (pdf-extract.ts's defaultExtractInvoiceFromText) has no
// seam reachable from a real HTTP request and calls the live Anthropic API
// -- portal-upload-extraction-stub.ts's PORTAL_UPLOAD_EXTRACTION_STUB_CARRIER
// env flag (set by this job, see ci.yml) opens a deterministic double for
// ONLY the new portal route, scoped to this job's own server process; the
// internal /api/invoice-drafts route (invoice-drafts-routes.ts) is
// untouched.
//
// AC1's nav-visibility-for-client_admin and AC2's nav-absence-for-
// client_viewer are the SAME shell portal-shell.fullstack.spec.ts already
// exercises with a 5-item nav count assertion for E2E_PORTAL_EMAIL
// (client_viewer) -- that test is left unmodified and still passes (Uploads
// stays absent for that role), so this file adds the client_admin-side
// assertion plus an explicit client_viewer-side absence check rather than
// re-deriving the same shell coverage.

let pool: pg.Pool;
const draftInvoiceNumbers: string[] = [];

function uniqueInvoiceNumber(tag: string): string {
  return `INV-PORTAL-E2E-${tag}-${Date.now()}`;
}

async function uploadInvoicePdf(page: import('@playwright/test').Page, invoiceNumber: string): Promise<void> {
  const pdf = await makeTextPdf(['E2E Portal Upload Invoice', `INVOICE_NUMBER:${invoiceNumber}`]);
  await page.getByTestId('invoice-upload-input').setInputFiles({
    name: 'invoice.pdf',
    mimeType: 'application/pdf',
    buffer: pdf,
  });
  await expect(page.getByTestId('invoice-review-form')).toBeVisible();
}

test.beforeAll(async ({ request }) => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  // Both checks share `request`'s own cookie jar (worker-scoped fixture) --
  // once the first sign-in sets a session cookie, better-auth's CSRF
  // protection requires an explicit Origin header on the second call or it
  // 403s with MISSING_OR_NULL_ORIGIN (reproduced directly against a live
  // server before adding this; portal-shell.fullstack.spec.ts's own
  // beforeAll never hits this because it only ever signs in once).
  const origin = { origin: 'http://localhost:4181' };
  await assertSeeded(request, {
    check: () => request.post('/api/auth/sign-in/email', {
      headers: origin,
      data: { email: E2E_PORTAL_ADMIN_EMAIL, password: E2E_PORTAL_ADMIN_PASSWORD },
    }),
    errorHint: "Has 'npm run seed:e2e-portal-admin-user' been run against this database?",
  });
  await assertSeeded(request, {
    check: () => request.post('/api/auth/sign-in/email', {
      headers: origin,
      data: { email: E2E_PORTAL_EMAIL, password: E2E_PORTAL_PASSWORD },
    }),
    errorHint: "Has 'npm run seed:e2e-portal-user' been run against this database?",
  });
});

test.afterAll(async () => {
  // Dependency-ordered teardown scoped to exactly the invoice numbers this
  // file created (same "own draftId/auditRunId only" precedent as
  // invoice-draft-confirm.fullstack.spec.ts), never the shared DEV_CLIENT_ID
  // tenant's other fixture rows.
  if (draftInvoiceNumbers.length > 0) {
    const drafts = await pool.query<{ id: string; source_document_id: string; confirmed_audit_run_id: string | null }>(
      `SELECT d.id, d.source_document_id, d.confirmed_audit_run_id
       FROM invoice_draft d
       WHERE d.extracted_payload ->> 'invoiceNumber' = ANY($1::text[]) AND d.client_id = $2`,
      [draftInvoiceNumbers, DEV_CLIENT_ID],
    );
    for (const draft of drafts.rows) {
      await pool.query(`DELETE FROM audit_event WHERE entity_id = $1`, [draft.id]);
      await pool.query(`UPDATE invoice_draft SET confirmed_audit_run_id = NULL WHERE id = $1`, [draft.id]);
      if (draft.confirmed_audit_run_id) {
        const auditRunId = draft.confirmed_audit_run_id;
        // This draft's own invoice, resolved via its own audit run -- NOT a
        // invoice_number-in-ANY(...) lookup across every draft this file
        // created, which could return a different draft's still-referenced
        // invoice out of dependency order and trip audit_run_invoice_id_fkey.
        const invoiceRow = await pool.query<{ invoice_id: string }>(`SELECT invoice_id FROM audit_run WHERE id = $1`, [auditRunId]);
        await pool.query(`DELETE FROM audit_event WHERE entity_id = $1`, [auditRunId]);
        await pool.query(`DELETE FROM scorecard WHERE audit_run_id = $1`, [auditRunId]);
        await pool.query(`DELETE FROM charge_finding WHERE audit_run_id = $1`, [auditRunId]);
        await pool.query(`DELETE FROM gate_failure WHERE audit_run_id = $1`, [auditRunId]);
        await pool.query(`DELETE FROM variance_finding WHERE audit_run_id = $1`, [auditRunId]);
        await pool.query(`DELETE FROM audit_replay_manifest WHERE audit_run_id = $1`, [auditRunId]);
        await pool.query(`DELETE FROM payment_gate_decision WHERE audit_run_id = $1`, [auditRunId]);
        await pool.query(`DELETE FROM audit_run WHERE id = $1`, [auditRunId]);
        const invoiceId = invoiceRow.rows[0]?.invoice_id;
        if (invoiceId) {
          await pool.query(`DELETE FROM charge_fact WHERE invoice_id = $1`, [invoiceId]);
          await pool.query(`DELETE FROM invoice WHERE id = $1`, [invoiceId]);
        }
      }
      await pool.query(`DELETE FROM invoice_draft WHERE id = $1`, [draft.id]);
      // AC4 corrects a field before confirming, which writes an
      // extraction_field row per changed field (recordCorrectionDiff,
      // invoice-draft.ts) -- must clear before source_document.
      await pool.query(`DELETE FROM extraction_field WHERE source_document_id = $1`, [draft.source_document_id]);
      await pool.query(`DELETE FROM source_document WHERE id = $1`, [draft.source_document_id]);
    }
  }
  await pool.end();
});

test('AC1: a real client_admin session shows an Uploads nav item and reaches the Uploads section', async ({ page }) => {
  await page.goto('/');
  await loginViaForm(page, E2E_PORTAL_ADMIN_EMAIL, E2E_PORTAL_ADMIN_PASSWORD);
  await expect(page.getByTestId('portal-shell')).toBeVisible();

  await expect(page.getByRole('link', { name: 'Uploads' })).toBeVisible();
  await page.getByRole('link', { name: 'Uploads' }).click();
  await expect(page.getByTestId('client-uploads-view')).toBeVisible();
  // 86e36yrne landed the sibling Contract type in the same document-type
  // list this task's own Solution anticipated ("even though only one type
  // exists until the contract-upload sibling task lands") -- asserts
  // Invoice is present and still the pre-selected first entry, not that
  // it's the only one.
  await expect(page.getByTestId('uploads-document-type-item')).toHaveText(['Invoice', 'Contract']);
});

test('AC2: a real client_viewer session shows no Uploads nav item', async ({ page }) => {
  await page.goto('/');
  await loginViaForm(page, E2E_PORTAL_EMAIL, E2E_PORTAL_PASSWORD);
  await expect(page.getByTestId('portal-shell')).toBeVisible();

  await expect(page.getByRole('link', { name: 'Uploads' })).not.toBeVisible();
  await expect(page.getByText('Uploads')).toHaveCount(0);
});

test('AC3: uploading a real PDF through the browser renders the extracted fields in an editable review form', async ({ page }) => {
  await page.goto('/');
  await loginViaForm(page, E2E_PORTAL_ADMIN_EMAIL, E2E_PORTAL_ADMIN_PASSWORD);
  await page.getByRole('link', { name: 'Uploads' }).click();

  const invoiceNumber = uniqueInvoiceNumber('AC3');
  await uploadInvoicePdf(page, invoiceNumber);
  draftInvoiceNumbers.push(invoiceNumber);

  await expect(page.getByTestId('invoice-review-invoice-number')).toHaveValue(invoiceNumber);
  await expect(page.getByTestId('invoice-review-header-currency')).toHaveValue('USD');
  await expect(page.getByLabel('Charge 1 amount')).toHaveValue('500.0000');

  // Draft rejected here so this test leaves no confirmed audit run behind
  // for AC5's before/after count to trip over.
  await page.getByTestId('invoice-reject-button').click();
  await expect(page.getByTestId('invoice-rejected-status')).toBeVisible();
});

test('AC4: confirming as client_admin creates a real audit run, independently visible to the client_viewer session', async ({ page, browser }) => {
  await page.goto('/');
  await loginViaForm(page, E2E_PORTAL_ADMIN_EMAIL, E2E_PORTAL_ADMIN_PASSWORD);
  await page.getByRole('link', { name: 'Uploads' }).click();

  const invoiceNumber = uniqueInvoiceNumber('AC4');
  await uploadInvoicePdf(page, invoiceNumber);
  draftInvoiceNumbers.push(invoiceNumber);

  // AC4: correct a field before confirming -- the reviewer's own correction,
  // not a pass-through of the extracted value.
  await page.getByTestId('invoice-review-invoice-number').fill(invoiceNumber);
  await page.getByLabel('Charge 1 category').fill('LINEHAUL-CORRECTED');
  await page.getByTestId('invoice-confirm-button').click();
  await expect(page.getByTestId('invoice-confirmed-status')).toBeVisible();

  // Deliberately verified via a SEPARATE client_viewer session, not
  // client_admin's own -- client_admin is structurally excluded from
  // portal-content-routes.ts's client_viewer-only views by design (this
  // task's own Rabbit holes/No-gos). A fresh browser context is a genuinely
  // distinct session (its own cookie jar), not a page reload.
  const viewerContext = await browser.newContext();
  const viewerPage = await viewerContext.newPage();
  try {
    await viewerPage.goto('/');
    await loginViaForm(viewerPage, E2E_PORTAL_EMAIL, E2E_PORTAL_PASSWORD);
    await expect(viewerPage.getByTestId('portal-shell')).toBeVisible();

    await viewerPage.getByRole('link', { name: 'Invoices' }).click();
    await expect(viewerPage.getByTestId('client-invoices-view')).toBeVisible();
    const row = viewerPage.getByTestId('client-invoices-row').filter({ hasText: invoiceNumber });
    await expect(row).toBeVisible();
  } finally {
    await viewerContext.close();
  }

  // Not satisfied by the client_admin-visible success banner alone (per this
  // task's own AC4 wording) -- also assert the real row directly.
  const auditRunRow = await pool.query<{ id: string }>(
    `SELECT ar.id FROM audit_run ar JOIN invoice i ON i.id = ar.invoice_id WHERE i.client_id = $1 AND i.invoice_number = $2`,
    [DEV_CLIENT_ID, invoiceNumber],
  );
  expect(auditRunRow.rows[0]).toBeDefined();
});

test('AC5: rejecting a draft through the browser creates no audit run', async ({ page }) => {
  const before = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_run WHERE client_id = $1`, [DEV_CLIENT_ID]);

  await page.goto('/');
  await loginViaForm(page, E2E_PORTAL_ADMIN_EMAIL, E2E_PORTAL_ADMIN_PASSWORD);
  await page.getByRole('link', { name: 'Uploads' }).click();

  const invoiceNumber = uniqueInvoiceNumber('AC5');
  await uploadInvoicePdf(page, invoiceNumber);
  draftInvoiceNumbers.push(invoiceNumber);

  await page.getByTestId('invoice-reject-button').click();
  await expect(page.getByTestId('invoice-rejected-status')).toBeVisible();

  const after = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_run WHERE client_id = $1`, [DEV_CLIENT_ID]);
  expect(after.rows[0]!.n).toBe(before.rows[0]!.n);

  const draftRow = await pool.query<{ status: string }>(
    `SELECT status FROM invoice_draft WHERE client_id = $1 AND extracted_payload ->> 'invoiceNumber' = $2`,
    [DEV_CLIENT_ID, invoiceNumber],
  );
  expect(draftRow.rows[0]!.status).toBe('rejected');
});
