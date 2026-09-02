import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { encodeCursor } from '../../src/shared/cursor-pagination.js';

// 86e2xcna3: registerFindingsRoutes now calls the shared
// registerTenantAuthPreHandler (tenant-auth.ts) instead of registering its
// own inline preHandler -- mocking this module wholesale (as every test
// below already did, without importOriginal) would otherwise wipe out that
// export too. This factory keeps the same "mock resolveAuthorizedTenantContext,
// let the real preHandler wiring run" shape every call site wants, without
// reimplementing the 401/tenantContext-set logic 4 times.
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
  }));
}

/**
 * Request-level unit coverage of GET /api/findings via Fastify's .inject(),
 * with db/tenant-context AND the tenant-auth preHandler mocked so this runs
 * with no live Postgres. Exercises the route handler itself (query parsing
 * incl. the kebab-case min-amount key, response shape) -- complementing
 * test/db/findings-endpoint.db.test.ts, which covers the same route against
 * a real DB (RLS, actual query results, actual membership gating) and stays
 * the source of truth there. The auth-gating behavior itself (401 on missing
 * headers / no membership) is covered by test/unit/tenant-auth.test.ts and
 * test/db/tenant-auth.db.test.ts, not re-asserted here -- these tests mock
 * resolveAuthorizedTenantContext to always authorize, so they can stay
 * focused on the route's own logic.
 */
describe('GET /api/findings (unit, mocked withTenantTx + tenant-auth)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.resetModules();
    vi.doUnmock('../../src/db/tenant-context.js');
    vi.doUnmock('../../src/modules/findings/tenant-auth.js');
  });

  function mockAuthorized() {
    mockTenantAuth({ clientIds: ['client-abc'], internal: false });
  }

  it('returns { findings } for an authorized request', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/findings/list-findings.js', () => ({
      listFindings: vi.fn().mockResolvedValue([{ id: 'f1', status: 'open' }]),
    }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/api/findings',
      headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ findings: [{ id: 'f1', status: 'open' }] });
  });

  it('reads the min-amount query param in kebab-case, not camelCase', async () => {
    mockAuthorized();
    const listFindings = vi.fn().mockResolvedValue([]);
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/findings/list-findings.js', () => ({ listFindings }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    await app.inject({
      method: 'GET',
      url: '/api/findings?min-amount=250&carrier=ACME&status=open',
      headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' },
    });

    expect(listFindings).toHaveBeenCalledWith(
      {},
      { carrier: 'ACME', status: 'open', minAmount: '250' },
    );
  });

  it('returns an empty findings array when no rows match', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    vi.doMock('../../src/modules/findings/list-findings.js', () => ({
      listFindings: vi.fn().mockResolvedValue([]),
    }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/api/findings',
      headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ findings: [] });
  });

  it('returns 401 when the request is not authorized', async () => {
    mockTenantAuth(null);
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/findings' });
    expect(res.statusCode).toBe(401);
  });

  // 86e2v24ye: before this fix, an invalid status broke listFindings' own
  // ::variance_status cast and reached Postgres unvalidated -- with no
  // setErrorHandler registered, that surfaced as a 500 reflecting raw
  // Postgres error detail. These assert the boundary rejects it before
  // listFindings (and therefore Postgres) is ever reached.
  describe('query param validation (86e2v24ye)', () => {
    it('returns 400 for an invalid status, without ever calling listFindings', async () => {
      mockAuthorized();
      const listFindings = vi.fn();
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/findings/list-findings.js', () => ({ listFindings }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'GET',
        url: '/api/findings?status=not-a-real-status',
        headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: expect.stringContaining('invalid status') });
      expect(listFindings).not.toHaveBeenCalled();
    });

    it('accepts every real variance_status value', async () => {
      mockAuthorized();
      const listFindings = vi.fn().mockResolvedValue([]);
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/findings/list-findings.js', () => ({ listFindings }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      // Matches migrations/0002_enums.sql's variance_status enum exactly.
      const realStatuses = [
        'open', 'in_review', 'accepted', 'waived',
        'queued_for_dispute', 'disputed', 'recovered', 'written_off', 'closed',
      ];
      for (const status of realStatuses) {
        const res = await app.inject({
          method: 'GET',
          url: `/api/findings?status=${status}`,
          headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' },
        });
        expect(res.statusCode).toBe(200);
      }
    });

    it('returns 400 for a non-numeric min-amount, without ever calling listFindings (kebab-case query key, matching 86e2u7j0d)', async () => {
      mockAuthorized();
      const listFindings = vi.fn();
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/findings/list-findings.js', () => ({ listFindings }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'GET',
        url: '/api/findings?min-amount=not-a-number',
        headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: expect.stringContaining('invalid min-amount') });
      expect(listFindings).not.toHaveBeenCalled();
    });

    it('accepts a valid numeric min-amount, including decimals', async () => {
      mockAuthorized();
      const listFindings = vi.fn().mockResolvedValue([]);
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/findings/list-findings.js', () => ({ listFindings }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'GET',
        url: '/api/findings?min-amount=250.50',
        headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' },
      });

      expect(res.statusCode).toBe(200);
      expect(listFindings).toHaveBeenCalledWith({}, expect.objectContaining({ minAmount: '250.50' }));
    });
  });

  describe('GET /api/gate-failures (86e2v17xn)', () => {
    it('returns { gateFailures } for an authorized request', async () => {
      mockAuthorized();
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/findings/list-gate-failures.js', () => ({
        listGateFailures: vi.fn().mockResolvedValue([{ id: 'gf1', defect: 'x' }]),
      }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'GET',
        url: '/api/gate-failures',
        headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' },
      });

      expect(res.statusCode).toBe(200);
      // P6.C.1: every /api/gate-failures response now also carries nextCursor.
      expect(res.json()).toEqual({ gateFailures: [{ id: 'gf1', defect: 'x' }], nextCursor: null });
    });

    it('passes the carrier query param through to listGateFailures', async () => {
      mockAuthorized();
      const listGateFailures = vi.fn().mockResolvedValue([]);
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/findings/list-gate-failures.js', () => ({ listGateFailures }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      await app.inject({
        method: 'GET',
        url: '/api/gate-failures?carrier=ACME',
        headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' },
      });

      // P6.C.1: limit is always inflated to effectiveLimit+1 internally.
      expect(listGateFailures).toHaveBeenCalledWith({}, { carrier: 'ACME', limit: 51, offset: undefined, cursor: undefined });
    });

    it('returns 401 when the request is not authorized', async () => {
      mockTenantAuth(null);
      const listGateFailures = vi.fn();
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/findings/list-gate-failures.js', () => ({ listGateFailures }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({ method: 'GET', url: '/api/gate-failures' });
      expect(res.statusCode).toBe(401);
      expect(listGateFailures).not.toHaveBeenCalled();
    });

    it('rejects combining cursor with offset, without calling listGateFailures (P6.C.1)', async () => {
      mockAuthorized();
      const listGateFailures = vi.fn();
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/findings/list-gate-failures.js', () => ({ listGateFailures }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const cursor = encodeCursor({ v: '2026-01-01T00:00:00.000Z', id: '10000000-0000-4000-8000-000000000001' });
      const res = await app.inject({
        method: 'GET', url: `/api/gate-failures?cursor=${cursor}&offset=10`,
        headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' },
      });
      expect(res.statusCode).toBe(400);
      expect(listGateFailures).not.toHaveBeenCalled();
    });

    it('rejects a malformed cursor with 400, without calling listGateFailures (P6.C.1)', async () => {
      mockAuthorized();
      const listGateFailures = vi.fn();
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/findings/list-gate-failures.js', () => ({ listGateFailures }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'GET', url: '/api/gate-failures?cursor=not-a-valid-cursor',
        headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' },
      });
      expect(res.statusCode).toBe(400);
      expect(listGateFailures).not.toHaveBeenCalled();
    });

    it('decodes a valid cursor and threads it through to listGateFailures (P6.C.1)', async () => {
      mockAuthorized();
      const listGateFailures = vi.fn().mockResolvedValue([]);
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/findings/list-gate-failures.js', () => ({ listGateFailures }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const cursor = encodeCursor({ v: '2026-01-01T00:00:00.000Z', id: '10000000-0000-4000-8000-000000000001' });
      const res = await app.inject({
        method: 'GET', url: `/api/gate-failures?cursor=${cursor}`,
        headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' },
      });
      expect(res.statusCode).toBe(200);
      expect(listGateFailures).toHaveBeenCalledWith({}, {
        carrier: undefined,
        limit: 51,
        offset: undefined,
        cursor: { id: '10000000-0000-4000-8000-000000000001' },
      });
    });

    it('rejects an out-of-range limit with 400 without calling listGateFailures (P6.C.1)', async () => {
      mockAuthorized();
      const listGateFailures = vi.fn();
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/findings/list-gate-failures.js', () => ({ listGateFailures }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'GET', url: '/api/gate-failures?limit=9999',
        headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' },
      });
      expect(res.statusCode).toBe(400);
      expect(listGateFailures).not.toHaveBeenCalled();
    });

    it('trims the overflow row and returns a nextCursor when more rows exist than the page limit (P6.C.1)', async () => {
      mockAuthorized();
      const rows = [
        { id: 'gf3', defect: 'x', recordedAt: new Date('2026-01-03T00:00:00.000Z') },
        { id: 'gf2', defect: 'x', recordedAt: new Date('2026-01-02T00:00:00.000Z') },
        { id: 'gf1', defect: 'x', recordedAt: new Date('2026-01-01T00:00:00.000Z') },
      ];
      const listGateFailures = vi.fn().mockResolvedValue(rows);
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/findings/list-gate-failures.js', () => ({ listGateFailures }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'GET', url: '/api/gate-failures?limit=2',
        headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.gateFailures).toEqual([
        { id: 'gf3', defect: 'x', recordedAt: '2026-01-03T00:00:00.000Z' },
        { id: 'gf2', defect: 'x', recordedAt: '2026-01-02T00:00:00.000Z' },
      ]);
      expect(body.nextCursor).not.toBeNull();
    });
  });

  describe('PATCH /api/findings/:id/status (86e2v1xyr)', () => {
    it('returns 200 and the new status for a valid, writable status transition', async () => {
      mockAuthorized();
      const updateFindingStatus = vi.fn().mockResolvedValue({ found: true });
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/findings/update-finding-status.js', () => ({ updateFindingStatus }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/findings/11111111-1111-1111-1111-111111111111/status',
        headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1', 'content-type': 'application/json' },
        payload: { status: 'in_review' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id: '11111111-1111-1111-1111-111111111111', status: 'in_review' });
      expect(updateFindingStatus).toHaveBeenCalledWith({}, '11111111-1111-1111-1111-111111111111', 'in_review', undefined, undefined);
    });

    it('returns 404 without calling reply with a 200 when the finding is not found for this tenant', async () => {
      mockAuthorized();
      const updateFindingStatus = vi.fn().mockResolvedValue({ found: false });
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/findings/update-finding-status.js', () => ({ updateFindingStatus }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/findings/22222222-2222-2222-2222-222222222222/status',
        headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1', 'content-type': 'application/json' },
        payload: { status: 'in_review' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 401 when unauthorized, without ever calling updateFindingStatus', async () => {
      mockTenantAuth(null);
      const updateFindingStatus = vi.fn();
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/findings/update-finding-status.js', () => ({ updateFindingStatus }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/findings/11111111-1111-1111-1111-111111111111/status',
        payload: { status: 'in_review' },
      });
      expect(res.statusCode).toBe(401);
      expect(updateFindingStatus).not.toHaveBeenCalled();
    });

    // 86e2v1xyr's explicit scope rule: the drawer (and this route) only
    // accept the 5 values the status FILTER dropdown also exposes -- a
    // finding set to one of the other 4 enum values would become
    // unreachable through the UI. Distinct, narrower set than GET
    // /api/findings' own VARIANCE_STATUS_VALUES query-param validation.
    it.each(['accepted', 'waived', 'recovered', 'written_off'])(
      'returns 400 for the non-writable status %s, without calling updateFindingStatus',
      async (status) => {
        mockAuthorized();
        const updateFindingStatus = vi.fn();
        vi.doMock('../../src/db/tenant-context.js', () => ({
          withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
        }));
        vi.doMock('../../src/modules/findings/update-finding-status.js', () => ({ updateFindingStatus }));
        const { buildApp } = await import('../../src/server/app.js');
        app = buildApp();

        const res = await app.inject({
          method: 'PATCH',
          url: '/api/findings/f1/status',
          headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1', 'content-type': 'application/json' },
          payload: { status },
        });
        expect(res.statusCode).toBe(400);
        expect(updateFindingStatus).not.toHaveBeenCalled();
      },
    );

    it('returns 400 for a garbage (non-enum, non-string) status value', async () => {
      mockAuthorized();
      const updateFindingStatus = vi.fn();
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/findings/update-finding-status.js', () => ({ updateFindingStatus }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/findings/11111111-1111-1111-1111-111111111111/status',
        headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1', 'content-type': 'application/json' },
        payload: { status: 12345 },
      });
      expect(res.statusCode).toBe(400);
      expect(updateFindingStatus).not.toHaveBeenCalled();
    });

    it('returns 400 when note is present but not a string', async () => {
      mockAuthorized();
      const updateFindingStatus = vi.fn();
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/findings/update-finding-status.js', () => ({ updateFindingStatus }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/findings/f1/status',
        headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1', 'content-type': 'application/json' },
        payload: { status: 'in_review', note: 42 },
      });
      expect(res.statusCode).toBe(400);
      expect(updateFindingStatus).not.toHaveBeenCalled();
    });

    it('passes note through to updateFindingStatus when provided', async () => {
      mockAuthorized();
      const updateFindingStatus = vi.fn().mockResolvedValue({ found: true });
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/findings/update-finding-status.js', () => ({ updateFindingStatus }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      await app.inject({
        method: 'PATCH',
        url: '/api/findings/11111111-1111-1111-1111-111111111111/status',
        headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1', 'content-type': 'application/json' },
        payload: { status: 'closed', note: 'analyst note' },
      });
      expect(updateFindingStatus).toHaveBeenCalledWith({}, '11111111-1111-1111-1111-111111111111', 'closed', 'analyst note', undefined);
    });
  });

  // 86e2v251e: sort/sortDir feed an ORDER BY server-side -- same boundary
  // validation pattern as status/min-amount above (86e2v24ye): reject before
  // withTenantTx/listFindings ever runs, since these can't be parameter-bound.
  describe('sort/sortDir query param validation (86e2v251e)', () => {
    it('returns 400 for an invalid sort key, without ever calling listFindings', async () => {
      mockAuthorized();
      const listFindings = vi.fn();
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/findings/list-findings.js', () => ({ listFindings }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'GET',
        url: '/api/findings?sort=invoiceNumber',
        headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: expect.stringContaining('invalid sort') });
      expect(listFindings).not.toHaveBeenCalled();
    });

    it('returns 400 for an invalid sortDir, without ever calling listFindings', async () => {
      mockAuthorized();
      const listFindings = vi.fn();
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/findings/list-findings.js', () => ({ listFindings }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'GET',
        url: '/api/findings?sort=variance&sortDir=up',
        headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: expect.stringContaining('invalid sortDir') });
      expect(listFindings).not.toHaveBeenCalled();
    });

    it('accepts sort=variance&sortDir=asc and passes both through to listFindings', async () => {
      mockAuthorized();
      const listFindings = vi.fn().mockResolvedValue([]);
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/findings/list-findings.js', () => ({ listFindings }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'GET',
        url: '/api/findings?sort=variance&sortDir=asc',
        headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' },
      });

      expect(res.statusCode).toBe(200);
      expect(listFindings).toHaveBeenCalledWith({}, expect.objectContaining({ sort: 'variance', sortDir: 'asc' }));
    });

    it('accepts sort=age with no sortDir', async () => {
      mockAuthorized();
      const listFindings = vi.fn().mockResolvedValue([]);
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/findings/list-findings.js', () => ({ listFindings }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'GET',
        url: '/api/findings?sort=age',
        headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' },
      });

      expect(res.statusCode).toBe(200);
      expect(listFindings).toHaveBeenCalledWith({}, expect.objectContaining({ sort: 'age', sortDir: undefined }));
    });
  });
});
