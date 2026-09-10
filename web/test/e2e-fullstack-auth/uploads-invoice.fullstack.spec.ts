import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { loginViaForm } from './login-form.js';
import { assertSeeded } from './assert-seeded.js';
import { E2E_PORTAL_ADMIN_EMAIL, E2E_PORTAL_ADMIN_PASSWORD } from '../../../scripts/seed-e2e-portal-admin-user.mjs';

/**
 * 86e36yj9d: the client-portal Uploads section's Invoice-type flow, driven
 * through a REAL browser upload against a real client_admin session (no
 * DEV_AUTH_HEADERS) -- the harness's own justification, same as
 * portal-shell.fullstack.spec.ts. The server's invoice-extraction call is
 * swapped for a deterministic double (E2E_FAKE_INVOICE_EXTRACTION=1, see
 * src/server/e2e-fake-extraction.ts) so this suite never reaches the live
 * Anthropic API; everything else (real PDF-text extraction via unpdf
 * against a real generated PDF, real carrier matching against the existing
 * seed:e2e-fullstack-fixture carrier, real draft persistence,
 * confirm/reject -> the real evaluate/persist pipeline) runs for real.
 */
async function makeFixturePdf(text: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 50, y: 740, size: 12, font });
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

test.beforeAll(async ({ request }) => {
  await assertSeeded(request, {
    check: () => request.post('/api/auth/sign-in/email', {
      data: { email: E2E_PORTAL_ADMIN_EMAIL, password: E2E_PORTAL_ADMIN_PASSWORD },
    }),
    errorHint: "Has 'npm run seed:e2e-portal-admin-user' been run against this database?",
  });
});

test('AC1: a client_admin sees Uploads in the nav, alongside every other section', async ({ page }) => {
  await page.goto('/');
  await loginViaForm(page, E2E_PORTAL_ADMIN_EMAIL, E2E_PORTAL_ADMIN_PASSWORD);
  await expect(page.getByTestId('portal-shell')).toBeVisible();
  await expect(page.getByTestId('portal-nav-item')).toHaveCount(6);
  await expect(page.getByRole('link', { name: 'Uploads' })).toBeVisible();
});

test('AC1/AC3/AC4: upload a PDF invoice, review the extracted fields, and confirm -- creates a real audit run', async ({ page }) => {
  await page.goto('/');
  await loginViaForm(page, E2E_PORTAL_ADMIN_EMAIL, E2E_PORTAL_ADMIN_PASSWORD);

  await page.getByRole('link', { name: 'Uploads' }).click();
  await expect(page.getByTestId('client-uploads-view')).toBeVisible();

  await page.getByTestId('upload-document-type-invoice').click();
  await expect(page.getByTestId('invoice-upload-flow')).toBeVisible();

  const pdf = await makeFixturePdf('E2E Uploads Invoice');
  await page.getByTestId('invoice-upload-input').setInputFiles({
    name: 'invoice.pdf',
    mimeType: 'application/pdf',
    buffer: pdf,
  });
  await page.getByTestId('invoice-upload-submit').click();

  await expect(page.getByTestId('invoice-review-form')).toBeVisible();
  await expect(page.getByTestId('invoice-review-invoice-number')).toHaveValue('INV-E2E-001');
  // money() canonicalizes to 4dp (charge-fact.ts) -- the fake extraction's
  // "150.00" input comes back normalized as "150.0000".
  await expect(page.getByTestId('invoice-review-charge-amount')).toHaveValue('150.0000');

  await page.getByTestId('invoice-review-confirm').click();

  await expect(page.getByTestId('invoice-upload-success')).toBeVisible();
});

test('AC5: rejecting a reviewed draft creates no audit run', async ({ page }) => {
  await page.goto('/');
  await loginViaForm(page, E2E_PORTAL_ADMIN_EMAIL, E2E_PORTAL_ADMIN_PASSWORD);

  await page.getByRole('link', { name: 'Uploads' }).click();
  await page.getByTestId('upload-document-type-invoice').click();

  const pdf = await makeFixturePdf('E2E Uploads Invoice (reject path)');
  await page.getByTestId('invoice-upload-input').setInputFiles({
    name: 'invoice-reject.pdf',
    mimeType: 'application/pdf',
    buffer: pdf,
  });
  await page.getByTestId('invoice-upload-submit').click();
  await expect(page.getByTestId('invoice-review-form')).toBeVisible();

  await page.getByTestId('invoice-review-reject').click();

  await expect(page.getByTestId('invoice-upload-rejected')).toBeVisible();
});

// AC2's route-rejection half (client_viewer gets 401 from
// /api/portal/invoice-drafts*) is proven server-side in
// test/db/portal-uploads-routes.db.test.ts -- this suite proves the
// nav-absence half is specific to role, not to every portal member.
test('AC2: the Uploads nav item is absent for a client_viewer session', async ({ page }) => {
  const { E2E_PORTAL_EMAIL, E2E_PORTAL_PASSWORD } = await import('../../../scripts/seed-e2e-portal-user.mjs');
  await page.goto('/');
  await loginViaForm(page, E2E_PORTAL_EMAIL, E2E_PORTAL_PASSWORD);
  await expect(page.getByTestId('portal-shell')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Uploads' })).not.toBeVisible();
});
