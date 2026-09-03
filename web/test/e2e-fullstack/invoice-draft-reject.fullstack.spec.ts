import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DEV_CLIENT_ID, DEV_USER_ID } from '../../../scripts/seed-dev-tenant.mjs';
import { withTenantTx } from '../../../src/db/tenant-context.js';
import { createInvoiceDraft } from '../../../src/modules/ingestion/invoice-draft.js';
import { runtimeObjectStore } from '../../../src/modules/reference-data/object-store-config.js';
import { makeTextPdf } from '../../../test/fixtures/pdf-invoice.js';
import type { ExtractedInvoice } from '../../../src/modules/ingestion/pdf-extract.js';

// 86e33qyxp: full-stack e2e for the invoice-draft reject path -- real
// Fastify server + real Postgres, no mocking of anything the test itself
// exercises.
//
// No dedicated invoice-draft review/reject UI exists in web/src (confirmed
// via grep -- same conclusion as the sibling P7.A.1/P7.A.3 investigation),
// so the reject step is driven directly via POST /api/invoice-drafts/:id/reject
// through Playwright's `request` fixture (real HTTP round-trip against the
// real route), not app.inject.
//
// The precondition ("a reviewed invoice draft") is seeded, not created via
// HTTP: POST /api/invoice-drafts's real production path calls the live
// Anthropic API (src/modules/ingestion/pdf-extract.ts's own header comment:
// "no test in this repo's suite exercises this real implementation end to
// end... unproven until someone runs it with a real key") -- exercising that
// in an e2e suite would mean a live external call, a real API key, real
// cost, and non-determinism, which no other fixture in this suite does.
// createInvoiceDraft's own extractImpl parameter (invoice-draft.ts:84-98) is
// the documented seam for exactly this -- called here in-process with a
// deterministic double, the same way scripts/seed-fullstack-e2e-fixture.mjs
// seeds its own precondition by calling the real pipeline directly rather
// than through HTTP. Only the reject step itself -- the thing this task is
// actually about -- goes over real HTTP against the real running server.

let pool: pg.Pool;

const fakeExtract = async (): Promise<ExtractedInvoice> => ({
  carrierName: 'E2E Reject Carrier',
  invoiceNumber: 'INV-E2E-REJECT-001',
  headerCurrency: 'USD',
  declaredTotal: '500.0000',
  charges: [{ code: '400', category: 'LINEHAUL', amount: '500.0000', currency: 'USD' }],
  extractable: true,
});

async function seedDraft(): Promise<string> {
  const pdf = await makeTextPdf(['E2E Reject Fixture Invoice', 'INV-E2E-REJECT-001']);
  const draft = await withTenantTx({ clientIds: [DEV_CLIENT_ID], internal: true }, (client) =>
    createInvoiceDraft(
      client,
      runtimeObjectStore(),
      { clientId: DEV_CLIENT_ID, pdfBytes: pdf, contentType: 'application/pdf' },
      fakeExtract,
    ));
  return draft.id;
}

let draftId: string;

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  draftId = await seedDraft();
});

test.afterAll(async () => {
  // Clean up under the shared dev tenant so this seeded row doesn't linger
  // across local reruns or interfere with other suites (e.g. test:db) that
  // share the same local Postgres instance -- CI runs this suite in its own
  // isolated database, so this is purely local hygiene, not a correctness
  // requirement of the test itself.
  const draft = await pool.query<{ source_document_id: string }>(`SELECT source_document_id FROM invoice_draft WHERE id = $1`, [draftId]);
  await pool.query(`DELETE FROM audit_event WHERE entity_id = $1`, [draftId]);
  await pool.query(`DELETE FROM invoice_draft WHERE id = $1`, [draftId]);
  if (draft.rows[0]) await pool.query(`DELETE FROM source_document WHERE id = $1`, [draft.rows[0].source_document_id]);
  await pool.end();
});

test('AC1: rejecting a reviewed draft marks it rejected and creates no audit run', async ({ request }) => {
  const before = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_run WHERE client_id = $1`, [DEV_CLIENT_ID]);

  const post = await request.post(`/api/invoice-drafts/${draftId}/reject`, {
    headers: { 'x-client-id': DEV_CLIENT_ID, 'x-user-id': DEV_USER_ID },
  });
  expect(post.status()).toBe(200);
  const body = await post.json() as { id: string; status: string };
  expect(body).toEqual({ id: draftId, status: 'rejected' });

  const draftRow = await pool.query<{ status: string }>(`SELECT status FROM invoice_draft WHERE id = $1`, [draftId]);
  expect(draftRow.rows[0]!.status).toBe('rejected');

  const after = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_run WHERE client_id = $1`, [DEV_CLIENT_ID]);
  expect(after.rows[0]!.n).toBe(before.rows[0]!.n);

  // Rejecting an already-finalized draft is refused, not silently accepted --
  // confirms rejection actually finalized the draft rather than leaving it
  // re-rejectable.
  const second = await request.post(`/api/invoice-drafts/${draftId}/reject`, {
    headers: { 'x-client-id': DEV_CLIENT_ID, 'x-user-id': DEV_USER_ID },
  });
  expect(second.status()).toBe(409);
});
