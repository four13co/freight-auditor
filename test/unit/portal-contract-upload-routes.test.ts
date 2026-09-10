import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 86e36yrne: request-level coverage of the client portal's own
 * /api/portal/contracts surface -- same isolated-registration pattern as
 * portal-invoice-upload-routes.test.ts (86e36yj9d): mocks client-admin-
 * auth.js so this proves the route composes registerClientAdminAuthPreHandler
 * correctly (a non-client_admin caller is rejected with 401 before the
 * handler runs, matching the established client_admin-gated-route contract),
 * plus the two domain-error mappings uploadContractDocument's own callers
 * already handle in contracts-routes.ts (ZodError -> 400,
 * ContractUploadConflictError -> 409).
 */
describe('portal contract upload route (client_admin-gated)', () => {
  let app: FastifyInstance | undefined;
  const CARRIER_ID = '11111111-1111-1111-1111-111111111111';

  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.resetModules();
    vi.doUnmock('../../src/db/tenant-context.js');
    vi.doUnmock('../../src/modules/identity/client-admin-auth.js');
    vi.doUnmock('../../src/modules/contracts/upload-contract-document.js');
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

  async function buildTestApp(withTenantTx: ReturnType<typeof vi.fn> = vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({}))) {
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    vi.doMock('../../src/modules/reference-data/object-store-config.js', () => ({ runtimeObjectStore: vi.fn() }));
    const { registerPortalContractUploadRoutes } = await import('../../src/server/portal-contract-upload-routes.js');
    app = Fastify();
    await app.register(registerPortalContractUploadRoutes);
    await app.ready();
    return withTenantTx;
  }

  it('rejects a non-client_admin caller (e.g. client_viewer) with 401, without uploading a contract', async () => {
    mockClientAdminAuth(null);
    const uploadContractDocument = vi.fn();
    vi.doMock('../../src/modules/contracts/upload-contract-document.js', () => ({
      uploadContractDocument,
      ContractUploadConflictError: class extends Error {},
      ContractUploadMetadataSchema: { parse: vi.fn() },
    }));
    const withTenantTx = await buildTestApp();

    const response = await app!.inject({
      method: 'POST',
      url: `/api/portal/contracts?carrier_id=${CARRIER_ID}&name=Acme&valid_from=2026-01-01`,
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from('%PDF-fake'),
    });

    expect(response.statusCode).toBe(401);
    expect(uploadContractDocument).not.toHaveBeenCalled();
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('rejects an empty body with 400 without uploading a contract', async () => {
    mockClientAdminAuth({ clientIds: [CARRIER_ID], internal: false });
    const uploadContractDocument = vi.fn();
    vi.doMock('../../src/modules/contracts/upload-contract-document.js', () => ({
      uploadContractDocument,
      ContractUploadConflictError: class extends Error {},
      ContractUploadMetadataSchema: { parse: vi.fn() },
    }));
    await buildTestApp();

    const response = await app!.inject({
      method: 'POST',
      url: `/api/portal/contracts?carrier_id=${CARRIER_ID}&name=Acme&valid_from=2026-01-01`,
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.alloc(0),
    });

    expect(response.statusCode).toBe(400);
    expect(uploadContractDocument).not.toHaveBeenCalled();
  });

  it('rejects malformed metadata with 400 before opening a tenant transaction (real Zod validation)', async () => {
    mockClientAdminAuth({ clientIds: [CARRIER_ID], internal: false });
    const uploadContractDocument = vi.fn();
    // Real ContractUploadMetadataSchema, not a mock -- proves the route's own
    // ZodError -> 400 catch clause, mirroring contracts-routes.test.ts's
    // equivalent coverage of the internal route's identical error mapping.
    const actual = await vi.importActual<typeof import('../../src/modules/contracts/upload-contract-document.js')>(
      '../../src/modules/contracts/upload-contract-document.js',
    );
    vi.doMock('../../src/modules/contracts/upload-contract-document.js', () => ({
      ...actual,
      uploadContractDocument,
    }));
    const withTenantTx = await buildTestApp();

    const response = await app!.inject({
      method: 'POST',
      url: `/api/portal/contracts?carrier_id=not-a-uuid&name=Acme&valid_from=2026-01-01`,
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from('%PDF-fake'),
    });

    expect(response.statusCode).toBe(400);
    expect(uploadContractDocument).not.toHaveBeenCalled();
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('maps a thrown ContractUploadConflictError to 409', async () => {
    mockClientAdminAuth({ clientIds: [CARRIER_ID], internal: false });
    vi.doMock('../../src/modules/contracts/upload-contract-document.js', () => {
      const ContractUploadConflictError = class extends Error {};
      return {
        uploadContractDocument: vi.fn().mockRejectedValue(new ContractUploadConflictError('carrier not found')),
        ContractUploadConflictError,
        ContractUploadMetadataSchema: { parse: vi.fn((v: unknown) => v) },
      };
    });
    await buildTestApp();

    const response = await app!.inject({
      method: 'POST',
      url: `/api/portal/contracts?carrier_id=${CARRIER_ID}&name=Acme&valid_from=2026-01-01`,
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from('%PDF-fake'),
    });

    expect(response.statusCode).toBe(409);
  });

  it('uploads a contract for an authorized client_admin caller and returns 201 on the happy path', async () => {
    mockClientAdminAuth({ clientIds: [CARRIER_ID], internal: false });
    const uploadContractDocument = vi.fn().mockResolvedValue({
      contractId: 'contract-1', contractVersionId: 'version-1', sourceDocumentId: 'doc-1', sha256: 'abc', created: true,
    });
    vi.doMock('../../src/modules/contracts/upload-contract-document.js', () => ({
      uploadContractDocument,
      ContractUploadConflictError: class extends Error {},
      ContractUploadMetadataSchema: { parse: vi.fn((v: unknown) => v) },
    }));
    await buildTestApp();

    const response = await app!.inject({
      method: 'POST',
      url: `/api/portal/contracts?carrier_id=${CARRIER_ID}&name=Acme&version_label=v1&valid_from=2026-01-01&valid_to=2027-01-01`,
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from('%PDF-fake'),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ contractId: 'contract-1', contractVersionId: 'version-1', sourceDocumentId: 'doc-1', sha256: 'abc', created: true });
    expect(uploadContractDocument).toHaveBeenCalled();
  });

  it('returns 200 (not 201) when the upload resolves to an existing (non-created) record', async () => {
    mockClientAdminAuth({ clientIds: [CARRIER_ID], internal: false });
    const uploadContractDocument = vi.fn().mockResolvedValue({
      contractId: 'contract-1', contractVersionId: 'version-1', sourceDocumentId: 'doc-1', sha256: 'abc', created: false,
    });
    vi.doMock('../../src/modules/contracts/upload-contract-document.js', () => ({
      uploadContractDocument,
      ContractUploadConflictError: class extends Error {},
      ContractUploadMetadataSchema: { parse: vi.fn((v: unknown) => v) },
    }));
    await buildTestApp();

    const response = await app!.inject({
      method: 'POST',
      url: `/api/portal/contracts?carrier_id=${CARRIER_ID}&name=Acme&valid_from=2026-01-01`,
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from('%PDF-fake'),
    });

    expect(response.statusCode).toBe(200);
  });
});
