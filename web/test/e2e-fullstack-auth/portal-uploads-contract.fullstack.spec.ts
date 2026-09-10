import { test, expect } from '@playwright/test';
import pg from 'pg';
import { loginViaForm } from './login-form.js';
import { assertSeeded } from './assert-seeded.js';
import { DEV_CLIENT_ID } from '../../../scripts/seed-dev-tenant.mjs';
import { E2E_PORTAL_ADMIN_EMAIL, E2E_PORTAL_ADMIN_PASSWORD } from '../../../scripts/seed-e2e-portal-admin-user.mjs';

// 86e36yrne: full-stack e2e for the Uploads section's Contract document
// type -- real browser, real login, real Fastify server, real Postgres,
// same harness as portal-uploads-invoice.fullstack.spec.ts (86e36yj9d, this
// same directory). Unlike Invoice, there is no extraction step to stub: the
// client supplies carrier/name/valid-from directly, so the browser upload
// (setInputFiles) plus a real form submit IS the whole flow -- no env-flag
// double needed here at all.
//
// AC2 (client_viewer deny) is unit-only per this task's own AC text
// (test/unit/portal-contract-upload-routes.test.ts), mirroring the Invoice
// type's own established 401 contract -- not re-asserted here.

let pool: pg.Pool;
let carrierId: string;
const createdContractNames: string[] = [];

function uniqueContractName(tag: string): string {
  return `E2E Portal Contract ${tag} ${Date.now()}`;
}

test.beforeAll(async ({ request }) => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await assertSeeded(request, {
    check: () => request.post('/api/auth/sign-in/email', {
      headers: { origin: 'http://localhost:4181' },
      data: { email: E2E_PORTAL_ADMIN_EMAIL, password: E2E_PORTAL_ADMIN_PASSWORD },
    }),
    errorHint: "Has 'npm run seed:e2e-portal-admin-user' been run against this database?",
  });

  const carrier = await pool.query<{ id: string }>(
    `INSERT INTO carrier (name) VALUES ($1) RETURNING id`,
    [`E2E Portal Contract Upload Carrier ${Date.now()}`],
  );
  carrierId = carrier.rows[0]!.id;
});

test.afterAll(async () => {
  // Dependency-ordered teardown scoped to exactly the contracts this file
  // created (same "own rows only" precedent as portal-uploads-invoice's
  // afterAll), never the shared DEV_CLIENT_ID tenant's other fixture rows.
  if (createdContractNames.length > 0) {
    const contracts = await pool.query<{ id: string }>(
      `SELECT id FROM contract WHERE client_id = $1 AND name = ANY($2::text[])`,
      [DEV_CLIENT_ID, createdContractNames],
    );
    for (const contract of contracts.rows) {
      const versions = await pool.query<{ id: string; source_document_id: string | null }>(
        `SELECT id, source_document_id FROM contract_version WHERE contract_id = $1`,
        [contract.id],
      );
      for (const version of versions.rows) {
        await pool.query(`DELETE FROM contract_version WHERE id = $1`, [version.id]);
        if (version.source_document_id) {
          await pool.query(`DELETE FROM source_document WHERE id = $1`, [version.source_document_id]);
        }
      }
      await pool.query(`DELETE FROM contract WHERE id = $1`, [contract.id]);
    }
  }
  if (carrierId) {
    await pool.query(`DELETE FROM carrier WHERE id = $1`, [carrierId]);
  }
  await pool.end();
});

test('AC1: a real client_admin session sees Contract as a second document type alongside Invoice', async ({ page }) => {
  await page.goto('/');
  await loginViaForm(page, E2E_PORTAL_ADMIN_EMAIL, E2E_PORTAL_ADMIN_PASSWORD);
  await expect(page.getByTestId('portal-shell')).toBeVisible();

  await page.getByRole('link', { name: 'Uploads' }).click();
  await expect(page.getByTestId('client-uploads-view')).toBeVisible();
  const items = page.getByTestId('uploads-document-type-item');
  await expect(items).toHaveText(['Invoice', 'Contract']);
});

test('AC3: uploading a real file with complete metadata through the browser creates a real contract', async ({ page }) => {
  await page.goto('/');
  await loginViaForm(page, E2E_PORTAL_ADMIN_EMAIL, E2E_PORTAL_ADMIN_PASSWORD);
  await page.getByRole('link', { name: 'Uploads' }).click();
  await page.getByTestId('uploads-document-type-item').filter({ hasText: 'Contract' }).click();
  await expect(page.getByTestId('contract-upload-panel')).toBeVisible();

  const contractName = uniqueContractName('AC3');
  await page.getByTestId('contract-upload-carrier-input').fill(carrierId);
  await page.getByTestId('contract-upload-name-input').fill(contractName);
  await page.getByTestId('contract-upload-valid-from-input').fill('2026-01-01');
  await page.getByTestId('contract-upload-input').setInputFiles({
    name: 'contract.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 fake contract bytes for e2e'),
  });
  createdContractNames.push(contractName);

  await page.getByTestId('contract-upload-submit-button').click();
  await expect(page.getByTestId('contract-upload-success')).toBeVisible();

  // Not satisfied by the client_admin-visible success banner alone (same
  // standard as the Invoice type's own AC4) -- assert the real row directly.
  const contractRow = await pool.query<{ id: string; carrier_id: string }>(
    `SELECT id, carrier_id FROM contract WHERE client_id = $1 AND name = $2`,
    [DEV_CLIENT_ID, contractName],
  );
  expect(contractRow.rows[0]).toBeDefined();
  expect(contractRow.rows[0]!.carrier_id).toBe(carrierId);

  const versionRow = await pool.query<{ valid_from: string }>(
    `SELECT valid_from::text FROM contract_version WHERE contract_id = $1`,
    [contractRow.rows[0]!.id],
  );
  expect(versionRow.rows[0]?.valid_from).toBe('2026-01-01');
});
