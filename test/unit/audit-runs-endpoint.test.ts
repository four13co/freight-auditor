import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// 86e2xcna3: registerAuditRunsRoutes now calls the shared
// registerTenantAuthPreHandler (tenant-auth.ts) -- same reasoning as
// findings-endpoint.test.ts's identical helper: mocking the whole module
// (as both call sites below already did) would otherwise wipe out that
// export too.
function mockTenantAuth(resolvedContext: unknown) {
  vi.doMock('../../src/modules/findings/tenant-auth.js', () => ({
    resolveAuthorizedTenantContext: vi.fn().mockResolvedValue(resolvedContext),
    registerTenantAuthPreHandler: async (routes: FastifyInstance) => {
      routes.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
        if (!resolvedContext) {
          await reply.code(401).send({ error: 'unauthorized' });
          return;
        }
        request.tenantContext = resolvedContext as FastifyRequest['tenantContext'];
      });
    },
    // P5.C.3: buildApp() now also registers portfolio-routes.ts, which imports
    // this export -- a wholesale mock of this module (as this file already did)
    // must carry it too, or buildApp() throws on the missing export, unrelated
    // to what this file actually tests.
    registerInternalAnalystAuthPreHandler: async (routes: FastifyInstance) => {
      routes.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
        if (!resolvedContext) {
          await reply.code(401).send({ error: 'unauthorized' });
          return;
        }
        request.tenantContext = resolvedContext as FastifyRequest['tenantContext'];
        if (!(resolvedContext as { internal?: boolean }).internal) {
          await reply.code(403).send({ error: 'internal analyst access required' });
        }
      });
    },
  }));
}

/**
 * Request-level unit coverage of POST /api/audit-runs via Fastify's
 * .inject(), with db/tenant-context, tenant-auth, and the ingest module all
 * mocked so this runs with no live Postgres -- same pattern as
 * test/unit/findings-endpoint.test.ts. Complements
 * test/db/audit-runs-endpoint.db.test.ts (the source of truth for the real
 * pipeline, RLS, and all 5+ ACs against a live DB); this file covers the
 * route's own request-handling logic (content-type parsing, the empty-body
 * guard, query-param plumbing, 422-on-UnparseableEdiError mapping) that the
 * unit suite's coverage gate can otherwise never see once app.ts's import
 * graph reaches this module (86e2v17u9).
 */
describe('POST /api/audit-runs (unit, mocked withTenantTx + tenant-auth + ingestInvoice)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.resetModules();
    vi.doUnmock('../../src/db/tenant-context.js');
    vi.doUnmock('../../src/modules/findings/tenant-auth.js');
    vi.doUnmock('../../src/modules/ingestion/ingest-invoice.js');
  });

  function mockAuthorized() {
    mockTenantAuth({ clientIds: ['client-abc'], internal: false });
  }

  it('returns 201 with { id, outcome } for a successful ingest, and threads the contract_version_id query param through', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const ingestInvoice = vi.fn().mockResolvedValue({ auditRunId: 'run-1', invoiceId: 'inv-1', outcome: 'SCORED' });
    vi.doMock('../../src/modules/ingestion/ingest-invoice.js', () => ({
      ingestInvoice,
      UnparseableEdiError: class UnparseableEdiError extends Error {},
    }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const wellFormedUuid = '11111111-2222-3333-4444-555555555555';
    const res = await app.inject({
      method: 'POST',
      url: `/api/audit-runs?contract_version_id=${wellFormedUuid}`,
      headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1', 'content-type': 'application/edi-x12' },
      payload: 'ISA*raw-edi-bytes~',
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: 'run-1', outcome: 'SCORED' });
    expect(ingestInvoice).toHaveBeenCalledWith(
      {},
      expect.anything(),
      expect.objectContaining({ clientId: 'client-abc', contractVersionId: wellFormedUuid }),
    );
  });

  it('AC1/86e2xcn18: rejects a malformed contract_version_id with 400, never calling ingestInvoice', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const ingestInvoice = vi.fn();
    vi.doMock('../../src/modules/ingestion/ingest-invoice.js', () => ({
      ingestInvoice,
      UnparseableEdiError: class UnparseableEdiError extends Error {},
    }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/audit-runs?contract_version_id=not-a-uuid',
      headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1', 'content-type': 'application/edi-x12' },
      payload: 'ISA*raw-edi-bytes~',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid contract_version_id: must be a well-formed UUID' });
    expect(ingestInvoice).not.toHaveBeenCalled();
  });

  it('omits contractVersionId from the ingest call when the query param is absent', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const ingestInvoice = vi.fn().mockResolvedValue({ auditRunId: 'run-2', invoiceId: 'inv-2', outcome: 'SCORED' });
    vi.doMock('../../src/modules/ingestion/ingest-invoice.js', () => ({
      ingestInvoice,
      UnparseableEdiError: class UnparseableEdiError extends Error {},
    }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    await app.inject({
      method: 'POST',
      url: '/api/audit-runs',
      headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1', 'content-type': 'text/plain' },
      payload: 'ISA*raw-edi-bytes~',
    });

    expect(ingestInvoice).toHaveBeenCalledWith(
      {},
      expect.anything(),
      expect.objectContaining({ contractVersionId: undefined }),
    );
  });

  it('maps UnparseableEdiError to 422 with the error message, not a 500', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    class UnparseableEdiError extends Error {}
    vi.doMock('../../src/modules/ingestion/ingest-invoice.js', () => ({
      ingestInvoice: vi.fn().mockRejectedValue(new UnparseableEdiError('no ST segment found')),
      UnparseableEdiError,
    }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/audit-runs',
      headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1', 'content-type': 'application/edi-x12' },
      payload: 'garbage',
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'no ST segment found' });
  });

  it('rethrows a non-UnparseableEdiError as a 500 (a genuine backend fault, not malformed input)', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/ingestion/ingest-invoice.js', () => ({
      ingestInvoice: vi.fn().mockRejectedValue(new Error('db connection lost')),
      UnparseableEdiError: class UnparseableEdiError extends Error {},
    }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/audit-runs',
      headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1', 'content-type': 'application/edi-x12' },
      payload: 'ISA*raw-edi-bytes~',
    });

    expect(res.statusCode).toBe(500);
  });

  it('rejects an empty body with 400, without calling ingestInvoice', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const ingestInvoice = vi.fn();
    vi.doMock('../../src/modules/ingestion/ingest-invoice.js', () => ({
      ingestInvoice,
      UnparseableEdiError: class UnparseableEdiError extends Error {},
    }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/audit-runs',
      headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1', 'content-type': 'application/edi-x12' },
      payload: '',
    });

    expect(res.statusCode).toBe(400);
    expect(ingestInvoice).not.toHaveBeenCalled();
  });

  it('returns 401 when tenant-auth resolves no context (missing headers)', async () => {
    mockTenantAuth(null);
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/audit-runs',
      headers: { 'content-type': 'application/edi-x12' },
      payload: 'ISA*raw-edi-bytes~',
    });

    expect(res.statusCode).toBe(401);
  });
});
