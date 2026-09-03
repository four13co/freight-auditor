import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DEV_CLIENT_ID, DEV_USER_ID } from '../../../scripts/seed-dev-tenant.mjs';
import { FIXTURE_CARRIER_NAME } from '../../../scripts/seed-fullstack-e2e-fixture.mjs';
import { withTenantTx } from '../../../src/db/tenant-context.js';
import { createInvoiceDraft } from '../../../src/modules/ingestion/invoice-draft.js';
import { runtimeObjectStore } from '../../../src/modules/reference-data/object-store-config.js';
import { makeTextPdf } from '../../../test/fixtures/pdf-invoice.js';
import type { ExtractedInvoice } from '../../../src/modules/ingestion/pdf-extract.js';

// 86e33qyx3: full-stack e2e for the invoice-draft confirm path -- real
// Fastify server + real Postgres, no mocking of anything the test itself
// exercises.
//
// No dedicated invoice-draft review UI exists in web/src (confirmed via
// grep -- same conclusion the sibling P7.A.4 investigation already reached),
// so the confirm step is driven directly via POST /api/invoice-drafts/:id/confirm
// through Playwright's `request` fixture (real HTTP round-trip against the
// real route), not app.inject.
//
// The precondition ("an invoice draft") is seeded in-process, not created
// via HTTP: POST /api/invoice-drafts's real production path calls the live
// Anthropic API (src/modules/ingestion/pdf-extract.ts's own header comment:
// "no test in this repo's suite exercises this real implementation end to
// end... unproven until someone runs it with a real key"). createInvoiceDraft's
// own extractImpl parameter (invoice-draft.ts:84-98) is the documented seam
// for exactly this -- same pattern invoice-draft-reject.fullstack.spec.ts
// (P7.A.4, PR #302) already established. No shared fixture helper exists on
// that file to import (its seedDraft/fakeExtract are private, unexported
// local functions), so this spec defines its own analogous pair rather than
// refactoring that already-merged file for an S-appetite test-coverage task.
//
// Per this task's own Rabbit holes: a real Dashboard-render assertion on the
// resulting audit run's findings is deliberately out of scope here -- unlike
// P7.A.1's GOLDEN_210/contract_version_id pairing (known to produce a real
// variance finding), this seeded draft payload's rubric outcome isn't
// pinned to a variance-producing fixture. This spec asserts the returned
// auditRunId and the real audit_run row, not a render.

let pool: pg.Pool;

// Reuses the already-seeded FIXTURE_CARRIER_NAME (seed-fullstack-e2e-fixture.mjs)
// so matchCarrierName resolves it exactly to a real carrier row -- an unmatched
// carrier name would leave the draft in 'needs_carrier_review' status, which
// requires an explicit carrierId on confirm and is a different scenario than
// this task's own "confirm with no corrections" AC.
const fakeExtract = async (): Promise<ExtractedInvoice> => ({
  carrierName: FIXTURE_CARRIER_NAME,
  invoiceNumber: 'INV-E2E-CONFIRM-001',
  headerCurrency: 'USD',
  declaredTotal: '500.0000',
  charges: [{ code: '400', category: 'LINEHAUL', amount: '500.0000', currency: 'USD' }],
  extractable: true,
});

async function seedDraft(): Promise<string> {
  const pdf = await makeTextPdf(['E2E Confirm Fixture Invoice', 'INV-E2E-CONFIRM-001']);
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
let auditRunId: string;
let invoiceId: string;

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  draftId = await seedDraft();
});

test.afterAll(async () => {
  // Dependency-ordered teardown scoped to this spec's own draftId/
  // auditRunId/invoiceId only -- never the shared DEV_CLIENT_ID's other
  // fixture rows (established pattern from PRs #303/#304/#305).
  const sourceDocument = await pool.query<{ source_document_id: string }>(`SELECT source_document_id FROM invoice_draft WHERE id = $1`, [draftId]);
  await pool.query(`DELETE FROM audit_event WHERE entity_id = $1`, [draftId]);
  if (auditRunId) {
    await pool.query(`DELETE FROM audit_event WHERE entity_id = $1`, [auditRunId]);
    await pool.query(`DELETE FROM scorecard WHERE audit_run_id = $1`, [auditRunId]);
    await pool.query(`DELETE FROM charge_finding WHERE audit_run_id = $1`, [auditRunId]);
    await pool.query(`DELETE FROM gate_failure WHERE audit_run_id = $1`, [auditRunId]);
    await pool.query(`DELETE FROM variance_finding WHERE audit_run_id = $1`, [auditRunId]);
    await pool.query(`DELETE FROM audit_replay_manifest WHERE audit_run_id = $1`, [auditRunId]);
  }
  if (invoiceId) {
    await pool.query(`DELETE FROM charge_fact WHERE invoice_id = $1`, [invoiceId]);
  }
  await pool.query(`UPDATE invoice_draft SET confirmed_audit_run_id = NULL WHERE id = $1`, [draftId]);
  if (auditRunId) await pool.query(`DELETE FROM audit_run WHERE id = $1`, [auditRunId]);
  if (invoiceId) await pool.query(`DELETE FROM invoice WHERE id = $1`, [invoiceId]);
  await pool.query(`DELETE FROM invoice_draft WHERE id = $1`, [draftId]);
  if (sourceDocument.rows[0]) await pool.query(`DELETE FROM source_document WHERE id = $1`, [sourceDocument.rows[0].source_document_id]);
  await pool.end();
});

test('AC1+AC2: confirming a draft over real HTTP creates a real audit run and marks the draft confirmed', async ({ request }) => {
  const post = await request.post(`/api/invoice-drafts/${draftId}/confirm`, {
    headers: { 'x-client-id': DEV_CLIENT_ID, 'x-user-id': DEV_USER_ID, 'content-type': 'application/json' },
    data: {},
  });
  expect(post.status()).toBe(201);
  const body = await post.json() as { auditRunId: string };
  expect(body.auditRunId).toEqual(expect.any(String));
  auditRunId = body.auditRunId;

  // AC1: a matching row exists in audit_run.
  const auditRunRow = await pool.query<{ id: string; invoice_id: string }>(`SELECT id, invoice_id FROM audit_run WHERE id = $1`, [auditRunId]);
  expect(auditRunRow.rows[0]).toBeDefined();
  invoiceId = auditRunRow.rows[0]!.invoice_id;

  // AC2: the draft's own state reflects confirmed -- not rejected, not
  // still pending -- and is linked to the audit run it produced.
  const draftRow = await pool.query<{ status: string; confirmed_audit_run_id: string }>(
    `SELECT status, confirmed_audit_run_id FROM invoice_draft WHERE id = $1`,
    [draftId],
  );
  expect(draftRow.rows[0]!.status).toBe('confirmed');
  expect(draftRow.rows[0]!.confirmed_audit_run_id).toBe(auditRunId);

  // Confirming an already-finalized draft is refused, not silently
  // reprocessed -- same guard-rail shape as the reject spec's own second call.
  const second = await request.post(`/api/invoice-drafts/${draftId}/confirm`, {
    headers: { 'x-client-id': DEV_CLIENT_ID, 'x-user-id': DEV_USER_ID, 'content-type': 'application/json' },
    data: {},
  });
  expect(second.status()).toBe(409);
});
