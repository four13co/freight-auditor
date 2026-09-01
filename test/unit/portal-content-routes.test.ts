import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Request-level unit coverage of GET /api/portal/invoices and
 * GET /api/portal/scorecard via Fastify's .inject(), with db/tenant-context
 * AND client-viewer-auth.ts's preHandler mocked so this runs with no live
 * Postgres -- same pattern as claim-recovery-endpoint.test.ts. Complements
 * test/db/portal-content-routes.db.test.ts, which covers the same routes
 * against a real DB, including the cross-tenant RLS proof.
 */
function mockClientViewerAuth(resolvedContext: { clientIds: string[] } | null) {
  vi.doMock('../../src/modules/identity/client-viewer-auth.js', () => ({
    registerClientViewerAuthPreHandler: async (routes: FastifyInstance) => {
      routes.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
        if (!resolvedContext) {
          await reply.code(401).send({ error: 'unauthorized' });
          return;
        }
        request.tenantContext = { clientIds: resolvedContext.clientIds, internal: false };
      });
    },
  }));
}

const CLIENT_ID = 'client-abc';

describe('portal content APIs (unit, mocked withTenantTx + client-viewer-auth)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.resetModules();
    vi.doUnmock('../../src/db/tenant-context.js');
    vi.doUnmock('../../src/modules/identity/client-viewer-auth.js');
  });

  function mockAuthorized() {
    mockClientViewerAuth({ clientIds: [CLIENT_ID] });
  }

  it('returns { invoices } for an authorized list request, threading the resolved clientId through', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const listClientInvoices = vi.fn().mockResolvedValue([{ id: 'i1', status: 'ingested' }]);
    vi.doMock('../../src/modules/portal/list-client-invoices.js', () => ({ listClientInvoices }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/portal/invoices' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ invoices: [{ id: 'i1', status: 'ingested' }] });
    expect(listClientInvoices).toHaveBeenCalledWith({}, CLIENT_ID, { status: undefined, limit: undefined, offset: undefined });
  });

  it('rejects an unauthenticated list request with 401, without calling listClientInvoices', async () => {
    mockClientViewerAuth(null);
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn() }));
    const listClientInvoices = vi.fn();
    vi.doMock('../../src/modules/portal/list-client-invoices.js', () => ({ listClientInvoices }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/portal/invoices' });
    expect(res.statusCode).toBe(401);
    expect(listClientInvoices).not.toHaveBeenCalled();
  });

  it('rejects an invoice list request with limit above the max with 400 without calling listClientInvoices', async () => {
    mockAuthorized();
    const listClientInvoices = vi.fn();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/portal/list-client-invoices.js', () => ({ listClientInvoices }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/portal/invoices?limit=9999' });
    expect(res.statusCode).toBe(400);
    expect(listClientInvoices).not.toHaveBeenCalled();
  });

  it('rejects an invoice list request with a negative offset with 400', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/portal/list-client-invoices.js', () => ({ listClientInvoices: vi.fn() }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/portal/invoices?offset=-1' });
    expect(res.statusCode).toBe(400);
  });

  it('returns { buckets } for an authorized scorecard request, threading the resolved clientId through', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const getClientScorecardSummary = vi.fn().mockResolvedValue([{ currency: 'USD', runCount: 1 }]);
    vi.doMock('../../src/modules/portal/get-client-scorecard-summary.js', () => ({ getClientScorecardSummary }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/portal/scorecard' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ buckets: [{ currency: 'USD', runCount: 1 }] });
    expect(getClientScorecardSummary).toHaveBeenCalledWith({}, CLIENT_ID);
  });

  it('rejects an unauthenticated scorecard request with 401, without calling getClientScorecardSummary', async () => {
    mockClientViewerAuth(null);
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn() }));
    const getClientScorecardSummary = vi.fn();
    vi.doMock('../../src/modules/portal/get-client-scorecard-summary.js', () => ({ getClientScorecardSummary }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/portal/scorecard' });
    expect(res.statusCode).toBe(401);
    expect(getClientScorecardSummary).not.toHaveBeenCalled();
  });
});
