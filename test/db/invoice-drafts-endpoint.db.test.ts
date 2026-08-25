import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { makeTextPdf, makeBlankPdf } from '../fixtures/pdf-invoice.js';
import type { ExtractedInvoice } from '../../src/modules/ingestion/pdf-extract.js';

/**
 * 86e2xb911: POST /api/invoice-drafts + POST /api/invoice-drafts/:id/confirm,
 * exercised at the HTTP layer end to end against a real ephemeral Postgres --
 * mirrors audit-runs-endpoint.db.test.ts's own justification for app.inject
 * over a mocked route.
 *
 * The LLM extraction call is mocked at the module boundary (defaultExtractInvoiceFromText)
 * -- this is the one production call site with no real-network test coverage
 * in this suite (see pdf-extract.ts's header comment). Every other step
 * (PDF text extraction via unpdf against a real generated PDF, carrier
 * matching against real rows, draft persistence, confirm -> the existing
 * evaluate/persist pipeline, extraction_field correction-diff writes) runs
 * for real.
 */
vi.mock('../../src/modules/ingestion/pdf-extract.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/modules/ingestion/pdf-extract.js')>(
    '../../src/modules/ingestion/pdf-extract.js',
  );
  return {
    ...actual,
    defaultExtractInvoiceFromText: vi.fn(),
  };
});

describe('POST /api/invoice-drafts + confirm (DB, e2e)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let clientId: string;
  let userId: string;
  let carrierId: string;
  let originalFlag: string | undefined;
  const tag = `draft-${Date.now()}`;

  beforeAll(async () => {
    originalFlag = process.env.DEV_AUTH_HEADERS;
    process.env.DEV_AUTH_HEADERS = '1';
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('Draft', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const u = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}@example.com`]);
      userId = u.rows[0].id;
      await owner.query(
        `INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_viewer')`,
        [userId, clientId],
      );
      const carrier = await owner.query(
        `INSERT INTO carrier (name) VALUES ($1) RETURNING id`,
        [`Acme Freight ${tag}`],
      );
      carrierId = carrier.rows[0].id;
    } finally {
      owner.release();
    }
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();
  });

  afterAll(async () => {
    if (originalFlag === undefined) delete process.env.DEV_AUTH_HEADERS;
    else process.env.DEV_AUTH_HEADERS = originalFlag;
    await app.close();
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM extraction_field WHERE client_id = $1`, [clientId]);
      // invoice_draft.confirmed_audit_run_id references audit_run -- clear the
      // draft rows (whole table for this client, not just referencing ones)
      // before deleting audit_run, or the FK blocks the delete.
      await owner.query(`DELETE FROM invoice_draft WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM variance_finding WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM scorecard WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM charge_finding WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM gate_failure WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM charge_fact WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM audit_run WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM invoice WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM source_document WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM carrier WHERE id = $1`, [carrierId]);
      await owner.query(`DELETE FROM membership WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM app_user WHERE id = $1`, [userId]);
      await owner.query(`DELETE FROM client WHERE id = $1`, [clientId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  async function mockExtraction(result: ExtractedInvoice): Promise<void> {
    const mod = await import('../../src/modules/ingestion/pdf-extract.js');
    (mod.defaultExtractInvoiceFromText as ReturnType<typeof vi.fn>).mockResolvedValue(result);
  }

  it('AC1: a clean PDF returns a draft with extracted charges/carrier match, and creates NO audit_run', async () => {
    await mockExtraction({
      carrierName: `Acme Freight ${tag}`,
      invoiceNumber: 'PDF-1',
      headerCurrency: 'USD',
      declaredTotal: '500.0000',
      charges: [{ code: '400', category: 'LINEHAUL', amount: '500.0000', currency: 'USD' }],
      extractable: true,
    });

    const before = await withTenantTx({ clientIds: [clientId], internal: true }, (c) =>
      c.query(`SELECT count(*)::int AS n FROM audit_run WHERE client_id = $1`, [clientId]),
    );

    const pdf = await makeTextPdf(['Acme Freight Invoice', 'PDF-1']);
    const post = await app.inject({
      method: 'POST',
      url: '/api/invoice-drafts',
      headers: { 'x-client-id': clientId, 'x-user-id': userId, 'content-type': 'application/pdf' },
      payload: pdf,
    });

    expect(post.statusCode).toBe(201);
    const body = post.json();
    expect(body.id).toEqual(expect.any(String));
    expect(body.status).toBe('extracted');
    expect(body.extractedPayload.charges).toHaveLength(1);
    expect(body.carrierCandidates).toEqual([]);

    const after = await withTenantTx({ clientIds: [clientId], internal: true }, (c) =>
      c.query(`SELECT count(*)::int AS n FROM audit_run WHERE client_id = $1`, [clientId]),
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('AC2: confirming a draft with no corrections creates a real audit run, visible via GET /api/findings', async () => {
    await mockExtraction({
      carrierName: `Acme Freight ${tag}`,
      invoiceNumber: 'PDF-2',
      headerCurrency: 'USD',
      declaredTotal: '500.0000',
      charges: [{ code: '400', category: 'LINEHAUL', amount: '500.0000', currency: 'USD' }],
      extractable: true,
    });

    const pdf = await makeTextPdf(['Acme Freight Invoice', 'PDF-2']);
    const draftPost = await app.inject({
      method: 'POST',
      url: '/api/invoice-drafts',
      headers: { 'x-client-id': clientId, 'x-user-id': userId, 'content-type': 'application/pdf' },
      payload: pdf,
    });
    const draftId = draftPost.json().id as string;

    const confirmPost = await app.inject({
      method: 'POST',
      url: `/api/invoice-drafts/${draftId}/confirm`,
      headers: { 'x-client-id': clientId, 'x-user-id': userId, 'content-type': 'application/json' },
      payload: {},
    });
    expect(confirmPost.statusCode).toBe(201);
    const auditRunId = confirmPost.json().auditRunId as string;
    expect(auditRunId).toEqual(expect.any(String));

    const get = await app.inject({
      method: 'GET',
      url: '/api/findings',
      headers: { 'x-client-id': clientId, 'x-user-id': userId },
    });
    expect(get.statusCode).toBe(200);
    expect(Array.isArray(get.json().findings)).toBe(true);

    const persisted = await withTenantTx({ clientIds: [clientId], internal: true }, (c) =>
      c.query(`SELECT transaction_set FROM invoice WHERE client_id = $1 ORDER BY created_at DESC LIMIT 1`, [clientId]),
    );
    expect(persisted.rows[0].transaction_set).toBe('PDF');

    const ledger = await withTenantTx({ clientIds: [clientId], internal: false }, (c) =>
      c.query(`SELECT event, entity_id, detail FROM audit_event WHERE entity_id = $1 ORDER BY recorded_at`, [draftId]),
    );
    expect(ledger.rows).toEqual([
      expect.objectContaining({ event: 'invoice_draft.extracted', entity_id: draftId }),
      expect.objectContaining({
        event: 'invoice_draft.confirmed',
        entity_id: draftId,
        detail: expect.objectContaining({ auditRunId }),
      }),
    ]);
  });

  it('AC3: confirming WITH corrections persists the corrected values and durably records the extraction/correction diff', async () => {
    await mockExtraction({
      carrierName: `Acme Freight ${tag}`,
      invoiceNumber: 'PDF-3',
      headerCurrency: 'USD',
      declaredTotal: '500.0000',
      charges: [{ code: '400', category: 'LINEHAUL', amount: '500.0000', currency: 'USD' }],
      extractable: true,
    });

    const pdf = await makeTextPdf(['Acme Freight Invoice', 'PDF-3']);
    const draftPost = await app.inject({
      method: 'POST',
      url: '/api/invoice-drafts',
      headers: { 'x-client-id': clientId, 'x-user-id': userId, 'content-type': 'application/pdf' },
      payload: pdf,
    });
    const draft = draftPost.json();
    const draftId = draft.id as string;

    const correctedPayload = {
      ...draft.extractedPayload,
      charges: [{ ...draft.extractedPayload.charges[0], amount: '650.0000' }],
      // The analyst corrects the footing total to match the corrected line
      // amount too -- otherwise STD.FOOTING's approx-compare gate would fail
      // on the mismatch and this test would prove nothing about the
      // corrected-value persistence path.
      footing: { declaredTotal: '650.0000', lineSum: '650.0000' },
    };

    const confirmPost = await app.inject({
      method: 'POST',
      url: `/api/invoice-drafts/${draftId}/confirm`,
      headers: { 'x-client-id': clientId, 'x-user-id': userId, 'content-type': 'application/json' },
      payload: { correctedPayload },
    });
    expect(confirmPost.statusCode).toBe(201);

    const chargeFact = await withTenantTx({ clientIds: [clientId], internal: true }, (c) =>
      c.query(
        `SELECT amount FROM charge_fact WHERE client_id = $1 AND invoice_id = (
           SELECT invoice_id FROM audit_run WHERE id = $2
         )`,
        [clientId, confirmPost.json().auditRunId],
      ),
    );
    expect(Number(chargeFact.rows[0].amount)).toBeCloseTo(650.0, 4);

    const diff = await withTenantTx({ clientIds: [clientId], internal: true }, (c) =>
      c.query(
        `SELECT ai_value, human_value FROM extraction_field WHERE client_id = $1 AND field_path = 'charges[0]'`,
        [clientId],
      ),
    );
    expect(diff.rows.length).toBeGreaterThanOrEqual(1);
    const row = diff.rows[diff.rows.length - 1];
    expect(row.ai_value.amount).toBe('500.0000');
    expect(row.human_value.amount).toBe('650.0000');

    // PR #112 review finding: this correctedPayload ALSO changes footing
    // (declaredTotal/lineSum 500 -> 650, required for STD.FOOTING's
    // approx-compare gate to still pass post-correction) -- that correction
    // must be durably captured too, not just charges[0]. Proves the fix:
    // recordCorrectionDiff now diffs header-level fields as well.
    const footingDiff = await withTenantTx({ clientIds: [clientId], internal: true }, (c) =>
      c.query(
        `SELECT ai_value, human_value FROM extraction_field WHERE client_id = $1 AND field_path = 'footing'`,
        [clientId],
      ),
    );
    expect(footingDiff.rows.length).toBeGreaterThanOrEqual(1);
    const footingRow = footingDiff.rows[footingDiff.rows.length - 1];
    expect(footingRow.ai_value).toEqual({ declaredTotal: '500.0000', lineSum: '500.0000' });
    expect(footingRow.human_value).toEqual({ declaredTotal: '650.0000', lineSum: '650.0000' });
  });

  it('AC4: a PDF the LLM cannot extract usefully from returns a 4xx, never a 500 and never a draft', async () => {
    await mockExtraction({ carrierName: '', charges: [], extractable: false });

    const pdf = await makeTextPdf(['completely garbled nonsense text']);
    const post = await app.inject({
      method: 'POST',
      url: '/api/invoice-drafts',
      headers: { 'x-client-id': clientId, 'x-user-id': userId, 'content-type': 'application/pdf' },
      payload: pdf,
    });

    expect(post.statusCode).toBeGreaterThanOrEqual(400);
    expect(post.statusCode).toBeLessThan(500);
  });

  it('AC4b: a truly blank PDF (no text at all) also returns a 4xx without reaching the LLM', async () => {
    const pdf = await makeBlankPdf();
    const post = await app.inject({
      method: 'POST',
      url: '/api/invoice-drafts',
      headers: { 'x-client-id': clientId, 'x-user-id': userId, 'content-type': 'application/pdf' },
      payload: pdf,
    });

    expect(post.statusCode).toBeGreaterThanOrEqual(400);
    expect(post.statusCode).toBeLessThan(500);
  });

  it('AC5: no tenant-auth headers -> 401 on both the draft and confirm endpoints', async () => {
    const pdf = await makeTextPdf(['irrelevant']);
    const draftRes = await app.inject({
      method: 'POST',
      url: '/api/invoice-drafts',
      headers: { 'content-type': 'application/pdf' },
      payload: pdf,
    });
    expect(draftRes.statusCode).toBe(401);

    const confirmRes = await app.inject({
      method: 'POST',
      url: '/api/invoice-drafts/00000000-0000-0000-0000-000000000000/confirm',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(confirmRes.statusCode).toBe(401);
  });
});
