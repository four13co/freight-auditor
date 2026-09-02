import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Request-level unit coverage of GET /api/portal/invoices and
 * GET /api/portal/scorecard/:auditRunId via Fastify's .inject(), with
 * db/tenant-context AND client-viewer-auth.ts's preHandler mocked so this
 * runs with no live Postgres -- same pattern as
 * claim-recovery-endpoint.test.ts. Complements
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

  const AUDIT_RUN_ID = '40000000-0000-4000-8000-000000000002';

  it('returns the scorecard for an authorized request, threading the resolved clientId and auditRunId through', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const scorecard = { auditRunId: AUDIT_RUN_ID, currency: 'USD', conformedCount: 8 };
    const getClientAuditRunScorecard = vi.fn().mockResolvedValue(scorecard);
    vi.doMock('../../src/modules/portal/get-client-audit-run-scorecard.js', () => ({ getClientAuditRunScorecard }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: `/api/portal/scorecard/${AUDIT_RUN_ID}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(scorecard);
    expect(getClientAuditRunScorecard).toHaveBeenCalledWith({}, CLIENT_ID, AUDIT_RUN_ID);
  });

  it('returns 404 when getClientAuditRunScorecard resolves null', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/portal/get-client-audit-run-scorecard.js', () => ({
      getClientAuditRunScorecard: vi.fn().mockResolvedValue(null),
    }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: `/api/portal/scorecard/${AUDIT_RUN_ID}` });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a malformed audit run id with 400, without calling getClientAuditRunScorecard', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const getClientAuditRunScorecard = vi.fn();
    vi.doMock('../../src/modules/portal/get-client-audit-run-scorecard.js', () => ({ getClientAuditRunScorecard }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/portal/scorecard/not-a-uuid' });
    expect(res.statusCode).toBe(400);
    expect(getClientAuditRunScorecard).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated scorecard request with 401, without calling getClientAuditRunScorecard', async () => {
    mockClientViewerAuth(null);
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn() }));
    const getClientAuditRunScorecard = vi.fn();
    vi.doMock('../../src/modules/portal/get-client-audit-run-scorecard.js', () => ({ getClientAuditRunScorecard }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: `/api/portal/scorecard/${AUDIT_RUN_ID}` });
    expect(res.statusCode).toBe(401);
    expect(getClientAuditRunScorecard).not.toHaveBeenCalled();
  });

  it('returns { findings } for an authorized list request, threading the resolved clientId through', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const listClientFindings = vi.fn().mockResolvedValue([{ id: 'f1', status: 'open' }]);
    vi.doMock('../../src/modules/portal/list-client-findings.js', () => ({ listClientFindings }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/portal/findings' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ findings: [{ id: 'f1', status: 'open' }] });
    expect(listClientFindings).toHaveBeenCalledWith({}, CLIENT_ID, {
      carrier: undefined, status: undefined, minAmount: undefined, sort: undefined, sortDir: undefined, limit: undefined, offset: undefined,
    });
  });

  it('rejects an unauthenticated findings list request with 401, without calling listClientFindings', async () => {
    mockClientViewerAuth(null);
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn() }));
    const listClientFindings = vi.fn();
    vi.doMock('../../src/modules/portal/list-client-findings.js', () => ({ listClientFindings }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/portal/findings' });
    expect(res.statusCode).toBe(401);
    expect(listClientFindings).not.toHaveBeenCalled();
  });

  it('rejects a findings list request with an invalid status with 400 without calling listClientFindings', async () => {
    mockAuthorized();
    const listClientFindings = vi.fn();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/portal/list-client-findings.js', () => ({ listClientFindings }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/portal/findings?status=not-a-status' });
    expect(res.statusCode).toBe(400);
    expect(listClientFindings).not.toHaveBeenCalled();
  });

  it('rejects a findings list request with a non-numeric min-amount with 400', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/portal/list-client-findings.js', () => ({ listClientFindings: vi.fn() }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/portal/findings?min-amount=abc' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a findings list request with an invalid sort with 400', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/portal/list-client-findings.js', () => ({ listClientFindings: vi.fn() }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/portal/findings?sort=bogus' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a findings list request with a limit above the max with 400', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/portal/list-client-findings.js', () => ({ listClientFindings: vi.fn() }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/portal/findings?limit=9999' });
    expect(res.statusCode).toBe(400);
  });

  const FINDING_ID = '40000000-0000-4000-8000-000000000003';

  it('returns the evidence chain for an authorized request, threading the resolved clientId and finding id through', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const chain = { finding: { id: FINDING_ID }, criterion: { key: 'CONTRACT.RATE_VARIANCE' } };
    const getDefensibilityChain = vi.fn().mockResolvedValue(chain);
    vi.doMock('../../src/modules/findings/get-defensibility-chain.js', () => ({ getDefensibilityChain }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: `/api/portal/findings/${FINDING_ID}/evidence` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(chain);
    expect(getDefensibilityChain).toHaveBeenCalledWith({}, CLIENT_ID, FINDING_ID);
  });

  it('returns 404 when getDefensibilityChain resolves null (not found, or belongs to a different client)', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/findings/get-defensibility-chain.js', () => ({
      getDefensibilityChain: vi.fn().mockResolvedValue(null),
    }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: `/api/portal/findings/${FINDING_ID}/evidence` });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a malformed finding id with 400, without calling getDefensibilityChain', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const getDefensibilityChain = vi.fn();
    vi.doMock('../../src/modules/findings/get-defensibility-chain.js', () => ({ getDefensibilityChain }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/portal/findings/not-a-uuid/evidence' });
    expect(res.statusCode).toBe(400);
    expect(getDefensibilityChain).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated evidence request with 401, without calling getDefensibilityChain', async () => {
    mockClientViewerAuth(null);
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn() }));
    const getDefensibilityChain = vi.fn();
    vi.doMock('../../src/modules/findings/get-defensibility-chain.js', () => ({ getDefensibilityChain }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: `/api/portal/findings/${FINDING_ID}/evidence` });
    expect(res.statusCode).toBe(401);
    expect(getDefensibilityChain).not.toHaveBeenCalled();
  });

  it('has no POST/PUT/PATCH/DELETE route registered on the findings list or evidence paths -- no write surface exists to protect (No-gos: read-only)', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/portal/list-client-findings.js', () => ({ listClientFindings: vi.fn() }));
    vi.doMock('../../src/modules/findings/get-defensibility-chain.js', () => ({ getDefensibilityChain: vi.fn() }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const listRes = await app.inject({ method, url: '/api/portal/findings' });
      expect(listRes.statusCode).toBe(404);
      const evidenceRes = await app.inject({ method, url: `/api/portal/findings/${FINDING_ID}/evidence` });
      expect(evidenceRes.statusCode).toBe(404);
    }
  });
});
