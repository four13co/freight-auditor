import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

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
    vi.doMock('../../src/modules/findings/tenant-auth.js', () => ({
      resolveAuthorizedTenantContext: vi.fn().mockResolvedValue({ clientIds: ['client-abc'], internal: false }),
    }));
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

    const res = await app.inject({
      method: 'POST',
      url: '/api/audit-runs?contract_version_id=cv-123',
      headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1', 'content-type': 'application/edi-x12' },
      payload: 'ISA*raw-edi-bytes~',
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: 'run-1', outcome: 'SCORED' });
    expect(ingestInvoice).toHaveBeenCalledWith(
      {},
      expect.anything(),
      expect.objectContaining({ clientId: 'client-abc', contractVersionId: 'cv-123' }),
    );
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
    vi.doMock('../../src/modules/findings/tenant-auth.js', () => ({
      resolveAuthorizedTenantContext: vi.fn().mockResolvedValue(null),
    }));
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
