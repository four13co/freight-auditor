import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { makeTextPdf } from '../fixtures/pdf-invoice.js';
import type { ExtractedInvoice } from '../../src/modules/ingestion/pdf-extract.js';

/**
 * 86e36yj9d: the client-portal Uploads section's Invoice-type routes
 * (/api/portal/invoice-drafts*, portal-uploads-routes.ts), exercised at the
 * HTTP layer end to end against a real ephemeral Postgres -- same shape as
 * invoice-drafts-endpoint.db.test.ts, this suite's own precedent for the
 * routes this one reuses the business logic of. Proves what that suite
 * doesn't: the client_admin-only gate (a client_viewer membership must be
 * structurally rejected here, unlike /api/invoice-drafts) and the new
 * /api/portal/* paths themselves.
 *
 * The LLM extraction call is mocked at the module boundary, same reasoning
 * as invoice-drafts-endpoint.db.test.ts.
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

describe('POST /api/portal/invoice-drafts + confirm/reject (DB, e2e)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let clientId: string;
  let adminUserId: string;
  let viewerUserId: string;
  let carrierId: string;
  let originalFlag: string | undefined;
  const tag = `portal-draft-${Date.now()}`;

  beforeAll(async () => {
    originalFlag = process.env.DEV_AUTH_HEADERS;
    process.env.DEV_AUTH_HEADERS = '1';
    pool = getPool();
    const owner = await pool.connect();
    try {
      const c = await owner.query(`INSERT INTO client (name, slug) VALUES ('Portal Draft', $1) RETURNING id`, [tag]);
      clientId = c.rows[0].id;
      const admin = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-admin@example.com`]);
      adminUserId = admin.rows[0].id;
      const viewer = await owner.query(`INSERT INTO app_user (email) VALUES ($1) RETURNING id`, [`${tag}-viewer@example.com`]);
      viewerUserId = viewer.rows[0].id;
      await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_admin')`, [adminUserId, clientId]);
      await owner.query(`INSERT INTO membership (user_id, client_id, role) VALUES ($1, $2, 'client_viewer')`, [viewerUserId, clientId]);
      const carrier = await owner.query(`INSERT INTO carrier (name) VALUES ($1) RETURNING id`, [`Acme Freight ${tag}`]);
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
      await owner.query(`DELETE FROM audit_replay_manifest WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM extraction_field WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM invoice_draft WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM variance_finding WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM scorecard WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM charge_finding WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM gate_failure WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM charge_fact WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM payment_gate_decision WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM audit_run WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM invoice WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM source_document WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM carrier WHERE id = $1`, [carrierId]);
      await owner.query(`DELETE FROM membership WHERE client_id = $1`, [clientId]);
      await owner.query(`DELETE FROM app_user WHERE id = $1 OR id = $2`, [adminUserId, viewerUserId]);
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

  it('AC2 (deny path): a client_viewer membership is structurally rejected (401), unlike /api/invoice-drafts', async () => {
    const pdf = await makeTextPdf(['irrelevant']);
    const res = await app.inject({
      method: 'POST',
      url: '/api/portal/invoice-drafts',
      headers: { 'x-client-id': clientId, 'x-user-id': viewerUserId, 'content-type': 'application/pdf' },
      payload: pdf,
    });
    expect(res.statusCode).toBe(401);
  });

  it('AC5: no tenant-auth headers -> 401 on draft/confirm/reject', async () => {
    const pdf = await makeTextPdf(['irrelevant']);
    const draftRes = await app.inject({ method: 'POST', url: '/api/portal/invoice-drafts', headers: { 'content-type': 'application/pdf' }, payload: pdf });
    expect(draftRes.statusCode).toBe(401);

    const confirmRes = await app.inject({
      method: 'POST',
      url: '/api/portal/invoice-drafts/00000000-0000-0000-0000-000000000000/confirm',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(confirmRes.statusCode).toBe(401);

    const rejectRes = await app.inject({ method: 'POST', url: '/api/portal/invoice-drafts/00000000-0000-0000-0000-000000000000/reject' });
    expect(rejectRes.statusCode).toBe(401);
  });

  it('AC1/AC3: a client_admin uploads a PDF, reviews, and confirms -- creates a real audit run', async () => {
    await mockExtraction({
      carrierName: `Acme Freight ${tag}`,
      invoiceNumber: 'PORTAL-PDF-1',
      headerCurrency: 'USD',
      declaredTotal: '150.0000',
      charges: [{ code: 'LHL', category: 'linehaul', amount: '150.0000', currency: 'USD' }],
      extractable: true,
    });

    const pdf = await makeTextPdf(['Acme Freight Invoice', 'PORTAL-PDF-1']);
    const draftPost = await app.inject({
      method: 'POST',
      url: '/api/portal/invoice-drafts',
      headers: { 'x-client-id': clientId, 'x-user-id': adminUserId, 'content-type': 'application/pdf' },
      payload: pdf,
    });
    expect(draftPost.statusCode).toBe(201);
    const draft = draftPost.json();
    expect(draft.status).toBe('extracted');
    expect(draft.extractedPayload.charges).toHaveLength(1);
    expect(draft.carrierCandidates).toEqual([]);

    const confirmPost = await app.inject({
      method: 'POST',
      url: `/api/portal/invoice-drafts/${draft.id}/confirm`,
      headers: { 'x-client-id': clientId, 'x-user-id': adminUserId, 'content-type': 'application/json' },
      payload: {},
    });
    expect(confirmPost.statusCode).toBe(201);
    const auditRunId = confirmPost.json().auditRunId as string;
    expect(auditRunId).toEqual(expect.any(String));

    const persisted = await withTenantTx({ clientIds: [clientId], internal: true }, (c) =>
      c.query(`SELECT transaction_set FROM invoice WHERE client_id = $1 ORDER BY created_at DESC LIMIT 1`, [clientId]),
    );
    expect(persisted.rows[0].transaction_set).toBe('PDF');
  });

  it('AC5 (reject): a client_admin rejects a draft -- no audit run is created', async () => {
    await mockExtraction({
      carrierName: `Acme Freight ${tag}`,
      invoiceNumber: 'PORTAL-PDF-2',
      headerCurrency: 'USD',
      declaredTotal: '75.0000',
      charges: [{ code: 'LHL', category: 'linehaul', amount: '75.0000', currency: 'USD' }],
      extractable: true,
    });

    const pdf = await makeTextPdf(['Acme Freight Invoice', 'PORTAL-PDF-2']);
    const draftPost = await app.inject({
      method: 'POST',
      url: '/api/portal/invoice-drafts',
      headers: { 'x-client-id': clientId, 'x-user-id': adminUserId, 'content-type': 'application/pdf' },
      payload: pdf,
    });
    const draftId = draftPost.json().id as string;

    const before = await withTenantTx({ clientIds: [clientId], internal: true }, (c) =>
      c.query(`SELECT count(*)::int AS n FROM audit_run WHERE client_id = $1`, [clientId]),
    );

    const rejectPost = await app.inject({
      method: 'POST',
      url: `/api/portal/invoice-drafts/${draftId}/reject`,
      headers: { 'x-client-id': clientId, 'x-user-id': adminUserId },
    });
    expect(rejectPost.statusCode).toBe(200);
    expect(rejectPost.json()).toEqual({ id: draftId, status: 'rejected' });

    const after = await withTenantTx({ clientIds: [clientId], internal: true }, (c) =>
      c.query(`SELECT count(*)::int AS n FROM audit_run WHERE client_id = $1`, [clientId]),
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});
