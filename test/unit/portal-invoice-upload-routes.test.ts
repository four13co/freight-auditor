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

/**
 * 86e36yj9d rebuild (Coverage Gate FAIL on PR #364): confirm/reject were
 * previously exercised only by portal-uploads-invoice.fullstack.spec.ts's
 * e2e specs -- real coverage, but not instrumented by the vitest-based
 * Coverage Gate (npm run test:coverage). These request-level tests mirror
 * invoice-drafts-routes.test.ts's existing validation-ordering pattern
 * (reject before opening a tenant transaction) plus the four
 * domain-error-to-status-code mappings confirmInvoiceDraft/rejectInvoiceDraft
 * can throw.
 */
describe('portal invoice-drafts routes: /:id/confirm and /:id/reject', () => {
  let app: FastifyInstance | undefined;
  const DRAFT_ID = '22222222-2222-2222-2222-222222222222';

  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.resetModules();
    vi.doUnmock('../../src/db/tenant-context.js');
    vi.doUnmock('../../src/modules/identity/client-admin-auth.js');
    vi.doUnmock('../../src/modules/ingestion/invoice-draft.js');
    vi.doUnmock('../../src/modules/reference-data/object-store-config.js');
  });

  function mockClientAdminAuth() {
    vi.doMock('../../src/modules/identity/client-admin-auth.js', () => ({
      registerClientAdminAuthPreHandler: async (routes: FastifyInstance) => {
        routes.addHook('preHandler', async (request: FastifyRequest, _reply: FastifyReply) => {
          request.tenantContext = { clientIds: ['11111111-1111-1111-1111-111111111111'], internal: false } as never;
        });
      },
    }));
  }

  function mockInvoiceDraftModule(overrides: {
    confirmInvoiceDraft?: ReturnType<typeof vi.fn>;
    rejectInvoiceDraft?: ReturnType<typeof vi.fn>;
    safeParse?: ReturnType<typeof vi.fn>;
  } = {}) {
    vi.doMock('../../src/modules/ingestion/invoice-draft.js', () => ({
      createInvoiceDraft: vi.fn(),
      confirmInvoiceDraft: overrides.confirmInvoiceDraft ?? vi.fn(),
      rejectInvoiceDraft: overrides.rejectInvoiceDraft ?? vi.fn(),
      DraftNotFoundError: class extends Error {},
      DraftAlreadyConfirmedError: class extends Error {},
      DraftAlreadyFinalizedError: class extends Error {},
      CarrierRequiredError: class extends Error {},
      UnextractablePdfError: class extends Error {},
      CorrectedInvoiceSchema: { safeParse: overrides.safeParse ?? vi.fn() },
    }));
  }

  async function buildTestApp(withTenantTx: ReturnType<typeof vi.fn> = vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({}))) {
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    vi.doMock('../../src/modules/reference-data/object-store-config.js', () => ({ runtimeObjectStore: vi.fn() }));
    const { registerPortalInvoiceUploadRoutes } = await import('../../src/server/portal-invoice-upload-routes.js');
    app = Fastify();
    await app.register(registerPortalInvoiceUploadRoutes);
    await app.ready();
    return withTenantTx;
  }

  describe('POST /:id/confirm', () => {
    it('rejects a non-UUID draft id with 400 before opening a tenant transaction', async () => {
      mockClientAdminAuth();
      mockInvoiceDraftModule();
      const withTenantTx = await buildTestApp();

      const response = await app!.inject({ method: 'POST', url: '/api/portal/invoice-drafts/not-a-uuid/confirm', payload: {} });

      expect(response.statusCode).toBe(400);
      expect(withTenantTx).not.toHaveBeenCalled();
    });

    it('rejects a malformed carrierId with 400 before opening a tenant transaction', async () => {
      mockClientAdminAuth();
      mockInvoiceDraftModule();
      const withTenantTx = await buildTestApp();

      const response = await app!.inject({
        method: 'POST',
        url: `/api/portal/invoice-drafts/${DRAFT_ID}/confirm`,
        payload: { carrierId: 'not-a-uuid' },
      });

      expect(response.statusCode).toBe(400);
      expect(withTenantTx).not.toHaveBeenCalled();
    });

    it('rejects a malformed contractVersionId with 400 before opening a tenant transaction', async () => {
      mockClientAdminAuth();
      mockInvoiceDraftModule();
      const withTenantTx = await buildTestApp();

      const response = await app!.inject({
        method: 'POST',
        url: `/api/portal/invoice-drafts/${DRAFT_ID}/confirm`,
        payload: { contractVersionId: 'not-a-uuid' },
      });

      expect(response.statusCode).toBe(400);
      expect(withTenantTx).not.toHaveBeenCalled();
    });

    it('rejects a correctedPayload that fails CorrectedInvoiceSchema parsing with 400 before opening a tenant transaction', async () => {
      mockClientAdminAuth();
      const safeParse = vi.fn().mockReturnValue({ success: false, error: { issues: [{ message: 'invalid' }] } });
      mockInvoiceDraftModule({ safeParse });
      const withTenantTx = await buildTestApp();

      const response = await app!.inject({
        method: 'POST',
        url: `/api/portal/invoice-drafts/${DRAFT_ID}/confirm`,
        payload: { correctedPayload: { bogus: true } },
      });

      expect(response.statusCode).toBe(400);
      expect(withTenantTx).not.toHaveBeenCalled();
    });

    it.each([
      ['DraftNotFoundError', 404],
      ['DraftAlreadyConfirmedError', 409],
      ['DraftAlreadyFinalizedError', 409],
      ['CarrierRequiredError', 422],
    ] as const)('maps a thrown %s to %i', async (errorName, expectedStatus) => {
      mockClientAdminAuth();
      let ErrorCtor!: new (msg?: string) => Error;
      vi.doMock('../../src/modules/ingestion/invoice-draft.js', () => {
        const DraftNotFoundError = class extends Error {};
        const DraftAlreadyConfirmedError = class extends Error {};
        const DraftAlreadyFinalizedError = class extends Error {};
        const CarrierRequiredError = class extends Error {};
        const byName = { DraftNotFoundError, DraftAlreadyConfirmedError, DraftAlreadyFinalizedError, CarrierRequiredError };
        ErrorCtor = byName[errorName];
        return {
          createInvoiceDraft: vi.fn(),
          confirmInvoiceDraft: vi.fn().mockRejectedValue(new byName[errorName]('boom')),
          rejectInvoiceDraft: vi.fn(),
          DraftNotFoundError, DraftAlreadyConfirmedError, DraftAlreadyFinalizedError, CarrierRequiredError,
          UnextractablePdfError: class extends Error {},
          CorrectedInvoiceSchema: { safeParse: vi.fn() },
        };
      });
      await buildTestApp();

      const response = await app!.inject({
        method: 'POST',
        url: `/api/portal/invoice-drafts/${DRAFT_ID}/confirm`,
        payload: {},
      });

      expect(response.statusCode).toBe(expectedStatus);
      expect(ErrorCtor).toBeDefined();
    });

    it('confirms a draft and returns 201 with the audit run id on the happy path', async () => {
      mockClientAdminAuth();
      const confirmInvoiceDraft = vi.fn().mockResolvedValue({ auditRunId: 'run-123' });
      mockInvoiceDraftModule({ confirmInvoiceDraft });
      await buildTestApp();

      const response = await app!.inject({
        method: 'POST',
        url: `/api/portal/invoice-drafts/${DRAFT_ID}/confirm`,
        payload: {},
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ auditRunId: 'run-123' });
      expect(confirmInvoiceDraft).toHaveBeenCalled();
    });
  });

  describe('POST /:id/reject', () => {
    it('rejects a non-UUID draft id with 400 before opening a tenant transaction', async () => {
      mockClientAdminAuth();
      mockInvoiceDraftModule();
      const withTenantTx = await buildTestApp();

      const response = await app!.inject({ method: 'POST', url: '/api/portal/invoice-drafts/not-a-uuid/reject', payload: {} });

      expect(response.statusCode).toBe(400);
      expect(withTenantTx).not.toHaveBeenCalled();
    });

    it('maps a thrown DraftNotFoundError to 404', async () => {
      mockClientAdminAuth();
      vi.doMock('../../src/modules/ingestion/invoice-draft.js', () => {
        const DraftNotFoundError = class extends Error {};
        return {
          createInvoiceDraft: vi.fn(),
          confirmInvoiceDraft: vi.fn(),
          rejectInvoiceDraft: vi.fn().mockRejectedValue(new DraftNotFoundError('draft not found')),
          DraftNotFoundError,
          DraftAlreadyConfirmedError: class extends Error {},
          DraftAlreadyFinalizedError: class extends Error {},
          CarrierRequiredError: class extends Error {},
          UnextractablePdfError: class extends Error {},
          CorrectedInvoiceSchema: { safeParse: vi.fn() },
        };
      });
      await buildTestApp();

      const response = await app!.inject({ method: 'POST', url: `/api/portal/invoice-drafts/${DRAFT_ID}/reject`, payload: {} });

      expect(response.statusCode).toBe(404);
    });

    it('maps a thrown DraftAlreadyFinalizedError to 409', async () => {
      mockClientAdminAuth();
      vi.doMock('../../src/modules/ingestion/invoice-draft.js', () => {
        const DraftAlreadyFinalizedError = class extends Error {};
        return {
          createInvoiceDraft: vi.fn(),
          confirmInvoiceDraft: vi.fn(),
          rejectInvoiceDraft: vi.fn().mockRejectedValue(new DraftAlreadyFinalizedError('already finalized')),
          DraftNotFoundError: class extends Error {},
          DraftAlreadyConfirmedError: class extends Error {},
          DraftAlreadyFinalizedError,
          CarrierRequiredError: class extends Error {},
          UnextractablePdfError: class extends Error {},
          CorrectedInvoiceSchema: { safeParse: vi.fn() },
        };
      });
      await buildTestApp();

      const response = await app!.inject({ method: 'POST', url: `/api/portal/invoice-drafts/${DRAFT_ID}/reject`, payload: {} });

      expect(response.statusCode).toBe(409);
    });

    it('rejects a draft and returns 200 on the happy path', async () => {
      mockClientAdminAuth();
      const rejectInvoiceDraft = vi.fn().mockResolvedValue(undefined);
      mockInvoiceDraftModule({ rejectInvoiceDraft });
      await buildTestApp();

      const response = await app!.inject({ method: 'POST', url: `/api/portal/invoice-drafts/${DRAFT_ID}/reject`, payload: {} });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ id: DRAFT_ID, status: 'rejected' });
      expect(rejectInvoiceDraft).toHaveBeenCalled();
    });
  });
});
