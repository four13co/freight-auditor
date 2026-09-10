import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 86e36yj9d: request-level coverage of the client portal's own
 * /api/portal/invoice-drafts surface -- same isolated-registration pattern
 * as invoice-drafts-routes.test.ts (registers only this module, not the
 * full buildApp()), but mocks client-admin-auth.js instead of
 * tenant-auth.js, so this proves the route composes
 * registerClientAdminAuthPreHandler correctly (AC2's unit half: a
 * non-client_admin caller -- resolveClientAdminContext resolving null,
 * exactly what it does for a client_viewer role -- is rejected with 401
 * before the handler runs).
 */
describe('portal invoice-drafts routes (client_admin-gated)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.resetModules();
    vi.doUnmock('../../src/db/tenant-context.js');
    vi.doUnmock('../../src/modules/identity/client-admin-auth.js');
    vi.doUnmock('../../src/modules/ingestion/invoice-draft.js');
    vi.doUnmock('../../src/modules/reference-data/object-store-config.js');
  });

  function mockClientAdminAuth(ctx: { clientIds: string[]; internal: boolean } | null) {
    vi.doMock('../../src/modules/identity/client-admin-auth.js', () => ({
      registerClientAdminAuthPreHandler: async (routes: FastifyInstance) => {
        routes.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
          if (!ctx) {
            await reply.code(401).send({ error: 'unauthorized' });
            return;
          }
          request.tenantContext = ctx as never;
        });
      },
    }));
  }

  async function buildTestApp() {
    vi.doMock('../../src/modules/reference-data/object-store-config.js', () => ({ runtimeObjectStore: vi.fn() }));
    const { registerPortalInvoiceUploadRoutes } = await import('../../src/server/portal-invoice-upload-routes.js');
    app = Fastify();
    await app.register(registerPortalInvoiceUploadRoutes);
    await app.ready();
  }

  it('rejects a non-client_admin caller (e.g. client_viewer) with 401 on POST /api/portal/invoice-drafts, without creating a draft', async () => {
    mockClientAdminAuth(null);
    const createInvoiceDraft = vi.fn();
    vi.doMock('../../src/modules/ingestion/invoice-draft.js', () => ({
      createInvoiceDraft, confirmInvoiceDraft: vi.fn(), rejectInvoiceDraft: vi.fn(),
      DraftNotFoundError: class extends Error {}, DraftAlreadyConfirmedError: class extends Error {},
      DraftAlreadyFinalizedError: class extends Error {}, CarrierRequiredError: class extends Error {},
      UnextractablePdfError: class extends Error {},
      CorrectedInvoiceSchema: { safeParse: vi.fn() },
    }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn() }));
    await buildTestApp();

    const response = await app!.inject({
      method: 'POST',
      url: '/api/portal/invoice-drafts',
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from('%PDF-fake'),
    });

    expect(response.statusCode).toBe(401);
    expect(createInvoiceDraft).not.toHaveBeenCalled();
  });

  it('creates a draft for an authorized client_admin caller', async () => {
    mockClientAdminAuth({ clientIds: ['11111111-1111-1111-1111-111111111111'], internal: false });
    const createInvoiceDraft = vi.fn().mockResolvedValue({
      id: 'draft-1', status: 'extracted',
      extractedPayload: { transactionSet: 'PDF', parserVersion: 'pdf-llm-v1', charges: [], quarantinedCodes: [] },
      carrierCandidates: [],
    });
    vi.doMock('../../src/modules/ingestion/invoice-draft.js', () => ({
      createInvoiceDraft, confirmInvoiceDraft: vi.fn(), rejectInvoiceDraft: vi.fn(),
      DraftNotFoundError: class extends Error {}, DraftAlreadyConfirmedError: class extends Error {},
      DraftAlreadyFinalizedError: class extends Error {}, CarrierRequiredError: class extends Error {},
      UnextractablePdfError: class extends Error {},
      CorrectedInvoiceSchema: { safeParse: vi.fn() },
    }));
    const withTenantTx = vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({}));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    await buildTestApp();

    const response = await app!.inject({
      method: 'POST',
      url: '/api/portal/invoice-drafts',
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from('%PDF-fake'),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ id: 'draft-1', status: 'extracted', extractedPayload: { transactionSet: 'PDF', parserVersion: 'pdf-llm-v1', charges: [], quarantinedCodes: [] }, carrierCandidates: [] });
    expect(createInvoiceDraft).toHaveBeenCalled();
  });

  it('rejects an empty body with 400 without creating a draft', async () => {
    mockClientAdminAuth({ clientIds: ['11111111-1111-1111-1111-111111111111'], internal: false });
    const createInvoiceDraft = vi.fn();
    vi.doMock('../../src/modules/ingestion/invoice-draft.js', () => ({
      createInvoiceDraft, confirmInvoiceDraft: vi.fn(), rejectInvoiceDraft: vi.fn(),
      DraftNotFoundError: class extends Error {}, DraftAlreadyConfirmedError: class extends Error {},
      DraftAlreadyFinalizedError: class extends Error {}, CarrierRequiredError: class extends Error {},
      UnextractablePdfError: class extends Error {},
      CorrectedInvoiceSchema: { safeParse: vi.fn() },
    }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn() }));
    await buildTestApp();

    const response = await app!.inject({
      method: 'POST',
      url: '/api/portal/invoice-drafts',
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.alloc(0),
    });

    expect(response.statusCode).toBe(400);
    expect(createInvoiceDraft).not.toHaveBeenCalled();
  });
});
