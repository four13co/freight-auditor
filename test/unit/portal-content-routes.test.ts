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

  const DISPUTE_ID = '50000000-0000-4000-8000-000000000004';

  it('returns the dispute for an authorized request, threading the resolved clientId and disputeId through', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const detail = { id: DISPUTE_ID, status: 'draft', lines: [] };
    const getClientDisputeDetail = vi.fn().mockResolvedValue(detail);
    vi.doMock('../../src/modules/portal/get-client-dispute-detail.js', () => ({ getClientDisputeDetail }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: `/api/portal/disputes/${DISPUTE_ID}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(detail);
    expect(getClientDisputeDetail).toHaveBeenCalledWith({}, CLIENT_ID, DISPUTE_ID);
  });

  it('returns 404 when getClientDisputeDetail resolves null (not found, or belongs to a different client)', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/portal/get-client-dispute-detail.js', () => ({
      getClientDisputeDetail: vi.fn().mockResolvedValue(null),
    }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: `/api/portal/disputes/${DISPUTE_ID}` });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a malformed dispute id with 400, without calling getClientDisputeDetail', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const getClientDisputeDetail = vi.fn();
    vi.doMock('../../src/modules/portal/get-client-dispute-detail.js', () => ({ getClientDisputeDetail }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/portal/disputes/not-a-uuid' });
    expect(res.statusCode).toBe(400);
    expect(getClientDisputeDetail).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated dispute request with 401, without calling getClientDisputeDetail', async () => {
    mockClientViewerAuth(null);
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn() }));
    const getClientDisputeDetail = vi.fn();
    vi.doMock('../../src/modules/portal/get-client-dispute-detail.js', () => ({ getClientDisputeDetail }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: `/api/portal/disputes/${DISPUTE_ID}` });
    expect(res.statusCode).toBe(401);
    expect(getClientDisputeDetail).not.toHaveBeenCalled();
  });

  it('returns { communications } for an authorized request, only after confirming the dispute is visible to this clientId', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const getClientDisputeDetail = vi.fn().mockResolvedValue({ id: DISPUTE_ID, status: 'draft', lines: [] });
    vi.doMock('../../src/modules/portal/get-client-dispute-detail.js', () => ({ getClientDisputeDetail }));
    const comms = [{ id: 'c1', direction: 'outbound', body: 'hi', recordedAt: '2026-09-01T00:00:00Z' }];
    const listClientDisputeCommunications = vi.fn().mockResolvedValue(comms);
    vi.doMock('../../src/modules/portal/list-client-dispute-communications.js', () => ({ listClientDisputeCommunications }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: `/api/portal/disputes/${DISPUTE_ID}/communications` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ communications: comms });
    expect(getClientDisputeDetail).toHaveBeenCalledWith({}, CLIENT_ID, DISPUTE_ID);
    expect(listClientDisputeCommunications).toHaveBeenCalledWith({}, CLIENT_ID, DISPUTE_ID);
  });

  it('returns 404 for communications on a dispute that does not exist or belongs to a different client, without calling listClientDisputeCommunications', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/portal/get-client-dispute-detail.js', () => ({
      getClientDisputeDetail: vi.fn().mockResolvedValue(null),
    }));
    const listClientDisputeCommunications = vi.fn();
    vi.doMock('../../src/modules/portal/list-client-dispute-communications.js', () => ({ listClientDisputeCommunications }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: `/api/portal/disputes/${DISPUTE_ID}/communications` });
    expect(res.statusCode).toBe(404);
    expect(listClientDisputeCommunications).not.toHaveBeenCalled();
  });

  it('rejects a malformed dispute id on the communications route with 400', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const getClientDisputeDetail = vi.fn();
    vi.doMock('../../src/modules/portal/get-client-dispute-detail.js', () => ({ getClientDisputeDetail }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/portal/disputes/not-a-uuid/communications' });
    expect(res.statusCode).toBe(400);
    expect(getClientDisputeDetail).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated communications request with 401', async () => {
    mockClientViewerAuth(null);
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn() }));
    const getClientDisputeDetail = vi.fn();
    vi.doMock('../../src/modules/portal/get-client-dispute-detail.js', () => ({ getClientDisputeDetail }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: `/api/portal/disputes/${DISPUTE_ID}/communications` });
    expect(res.statusCode).toBe(401);
    expect(getClientDisputeDetail).not.toHaveBeenCalled();
  });

  it('has no POST/PUT/PATCH/DELETE route registered on the dispute detail or communications paths -- no write surface exists to protect (No-gos: read-only)', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/portal/get-client-dispute-detail.js', () => ({ getClientDisputeDetail: vi.fn() }));
    vi.doMock('../../src/modules/portal/list-client-dispute-communications.js', () => ({ listClientDisputeCommunications: vi.fn() }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const detailRes = await app.inject({ method, url: `/api/portal/disputes/${DISPUTE_ID}` });
      expect(detailRes.statusCode).toBe(404);
      const commsRes = await app.inject({ method, url: `/api/portal/disputes/${DISPUTE_ID}/communications` });
      expect(commsRes.statusCode).toBe(404);
    }
  });

  const CLAIM_ID = '60000000-0000-4000-8000-000000000005';

  it('returns the claim for an authorized request, threading the resolved clientId and claimId through', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const detail = { id: CLAIM_ID, status: 'open', recoveryEvents: [], cumulativeRecovered: '0.0000' };
    const getClaimDetail = vi.fn().mockResolvedValue(detail);
    vi.doMock('../../src/modules/claims/get-claim-detail.js', () => ({ getClaimDetail }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: `/api/portal/claims/${CLAIM_ID}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(detail);
    expect(getClaimDetail).toHaveBeenCalledWith({}, CLIENT_ID, CLAIM_ID);
  });

  it('returns 404 when getClaimDetail resolves null (not found, or belongs to a different client)', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/claims/get-claim-detail.js', () => ({ getClaimDetail: vi.fn().mockResolvedValue(null) }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: `/api/portal/claims/${CLAIM_ID}` });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a malformed claim id with 400, without calling getClaimDetail', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const getClaimDetail = vi.fn();
    vi.doMock('../../src/modules/claims/get-claim-detail.js', () => ({ getClaimDetail }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/portal/claims/not-a-uuid' });
    expect(res.statusCode).toBe(400);
    expect(getClaimDetail).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated claim request with 401, without calling getClaimDetail', async () => {
    mockClientViewerAuth(null);
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn() }));
    const getClaimDetail = vi.fn();
    vi.doMock('../../src/modules/claims/get-claim-detail.js', () => ({ getClaimDetail }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: `/api/portal/claims/${CLAIM_ID}` });
    expect(res.statusCode).toBe(401);
    expect(getClaimDetail).not.toHaveBeenCalled();
  });

  it('returns { documents } for an authorized request, threading the resolved clientId and claimId through', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const documents = [{ id: 'doc-1', sha256: 'a'.repeat(64), storageUri: 'r2://doc-1' }];
    const listClientClaimDocuments = vi.fn().mockResolvedValue(documents);
    vi.doMock('../../src/modules/portal/list-client-claim-documents.js', () => ({ listClientClaimDocuments }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: `/api/portal/claims/${CLAIM_ID}/documents` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ documents });
    expect(listClientClaimDocuments).toHaveBeenCalledWith({}, CLIENT_ID, CLAIM_ID);
  });

  it('returns 404 for documents when listClientClaimDocuments resolves null (claim not found, or belongs to a different client)', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/portal/list-client-claim-documents.js', () => ({
      listClientClaimDocuments: vi.fn().mockResolvedValue(null),
    }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: `/api/portal/claims/${CLAIM_ID}/documents` });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with an empty documents array when the claim exists but resolves no documents yet', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/portal/list-client-claim-documents.js', () => ({
      listClientClaimDocuments: vi.fn().mockResolvedValue([]),
    }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: `/api/portal/claims/${CLAIM_ID}/documents` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ documents: [] });
  });

  it('rejects a malformed claim id on the documents route with 400', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const listClientClaimDocuments = vi.fn();
    vi.doMock('../../src/modules/portal/list-client-claim-documents.js', () => ({ listClientClaimDocuments }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/portal/claims/not-a-uuid/documents' });
    expect(res.statusCode).toBe(400);
    expect(listClientClaimDocuments).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated documents request with 401', async () => {
    mockClientViewerAuth(null);
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn() }));
    const listClientClaimDocuments = vi.fn();
    vi.doMock('../../src/modules/portal/list-client-claim-documents.js', () => ({ listClientClaimDocuments }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: `/api/portal/claims/${CLAIM_ID}/documents` });
    expect(res.statusCode).toBe(401);
    expect(listClientClaimDocuments).not.toHaveBeenCalled();
  });

  it('has no POST/PUT/PATCH/DELETE route registered on the claim detail or documents paths -- no write surface exists to protect (No-gos: read-only)', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/claims/get-claim-detail.js', () => ({ getClaimDetail: vi.fn() }));
    vi.doMock('../../src/modules/portal/list-client-claim-documents.js', () => ({ listClientClaimDocuments: vi.fn() }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const detailRes = await app.inject({ method, url: `/api/portal/claims/${CLAIM_ID}` });
      expect(detailRes.statusCode).toBe(404);
      const docsRes = await app.inject({ method, url: `/api/portal/claims/${CLAIM_ID}/documents` });
      expect(docsRes.statusCode).toBe(404);
    }
  });

  it('returns { events } for an authorized audit-log request, threading the resolved clientId through', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const events = [{ id: 'e1', entity: 'dispute', entityId: 'd1', event: 'created', actorKind: 'analyst', recordedAt: '2026-01-01T00:00:00.000Z' }];
    const listClientAuditEvents = vi.fn().mockResolvedValue(events);
    vi.doMock('../../src/modules/portal/list-client-audit-events.js', () => ({ listClientAuditEvents }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/portal/audit-log' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ events });
    expect(listClientAuditEvents).toHaveBeenCalledWith({}, CLIENT_ID, {
      entity: undefined, event: undefined, from: undefined, to: undefined, limit: undefined, offset: undefined,
    });
  });

  it('returns 200 with an empty events array when no audit events exist yet', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/portal/list-client-audit-events.js', () => ({
      listClientAuditEvents: vi.fn().mockResolvedValue([]),
    }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/portal/audit-log' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ events: [] });
  });

  it('threads entity/event/from/to/limit/offset query params through to listClientAuditEvents', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const listClientAuditEvents = vi.fn().mockResolvedValue([]);
    vi.doMock('../../src/modules/portal/list-client-audit-events.js', () => ({ listClientAuditEvents }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/api/portal/audit-log?entity=dispute&event=created&from=2026-01-01T00%3A00%3A00Z&to=2026-02-01T00%3A00%3A00Z&limit=10&offset=20',
    });

    expect(res.statusCode).toBe(200);
    expect(listClientAuditEvents).toHaveBeenCalledWith({}, CLIENT_ID, {
      entity: 'dispute',
      event: 'created',
      from: new Date('2026-01-01T00:00:00Z'),
      to: new Date('2026-02-01T00:00:00Z'),
      limit: 10,
      offset: 20,
    });
  });

  it('rejects an invalid entity query param with 400, without calling listClientAuditEvents', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn() }));
    const listClientAuditEvents = vi.fn();
    vi.doMock('../../src/modules/portal/list-client-audit-events.js', () => ({ listClientAuditEvents }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/portal/audit-log?entity=NotValid!' });
    expect(res.statusCode).toBe(400);
    expect(listClientAuditEvents).not.toHaveBeenCalled();
  });

  it('rejects an invalid event query param with 400, without calling listClientAuditEvents', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn() }));
    const listClientAuditEvents = vi.fn();
    vi.doMock('../../src/modules/portal/list-client-audit-events.js', () => ({ listClientAuditEvents }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/portal/audit-log?event=NotValid!' });
    expect(res.statusCode).toBe(400);
    expect(listClientAuditEvents).not.toHaveBeenCalled();
  });

  it('rejects an unparseable from date with 400, without calling listClientAuditEvents', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn() }));
    const listClientAuditEvents = vi.fn();
    vi.doMock('../../src/modules/portal/list-client-audit-events.js', () => ({ listClientAuditEvents }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/portal/audit-log?from=not-a-date' });
    expect(res.statusCode).toBe(400);
    expect(listClientAuditEvents).not.toHaveBeenCalled();
  });

  it('rejects an unparseable to date with 400, without calling listClientAuditEvents', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn() }));
    const listClientAuditEvents = vi.fn();
    vi.doMock('../../src/modules/portal/list-client-audit-events.js', () => ({ listClientAuditEvents }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/portal/audit-log?to=not-a-date' });
    expect(res.statusCode).toBe(400);
    expect(listClientAuditEvents).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range limit on the audit-log route with 400', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn() }));
    const listClientAuditEvents = vi.fn();
    vi.doMock('../../src/modules/portal/list-client-audit-events.js', () => ({ listClientAuditEvents }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/portal/audit-log?limit=0' });
    expect(res.statusCode).toBe(400);
    expect(listClientAuditEvents).not.toHaveBeenCalled();
  });

  it('rejects a negative offset on the audit-log route with 400', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn() }));
    const listClientAuditEvents = vi.fn();
    vi.doMock('../../src/modules/portal/list-client-audit-events.js', () => ({ listClientAuditEvents }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/portal/audit-log?offset=-1' });
    expect(res.statusCode).toBe(400);
    expect(listClientAuditEvents).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated audit-log request with 401, without calling listClientAuditEvents', async () => {
    mockClientViewerAuth(null);
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn() }));
    const listClientAuditEvents = vi.fn();
    vi.doMock('../../src/modules/portal/list-client-audit-events.js', () => ({ listClientAuditEvents }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/portal/audit-log' });
    expect(res.statusCode).toBe(401);
    expect(listClientAuditEvents).not.toHaveBeenCalled();
  });

  it('has no POST/PUT/PATCH/DELETE route registered on the audit-log path -- no write surface exists to protect (No-gos: read-only)', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/portal/list-client-audit-events.js', () => ({ listClientAuditEvents: vi.fn() }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await app.inject({ method, url: '/api/portal/audit-log' });
      expect(res.statusCode).toBe(404);
    }
  });
});
