import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

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
    vi.doMock('../../src/modules/findings/tenant-auth.js', () => ({
      resolveAuthorizedTenantContext: vi.fn().mockResolvedValue({ clientIds: ['client-abc'], internal: false }),
    }));
  }

  it('returns { findings } for an authorized request', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
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
    vi.doMock('../../src/modules/findings/tenant-auth.js', () => ({
      resolveAuthorizedTenantContext: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
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
      expect(res.json()).toEqual({ gateFailures: [{ id: 'gf1', defect: 'x' }] });
    });

    it('passes the carrier query param through to listGateFailures', async () => {
      mockAuthorized();
      const listGateFailures = vi.fn().mockResolvedValue([]);
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/findings/list-gate-failures.js', () => ({ listGateFailures }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      await app.inject({
        method: 'GET',
        url: '/api/gate-failures?carrier=ACME',
        headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' },
      });

      expect(listGateFailures).toHaveBeenCalledWith({}, { carrier: 'ACME' });
    });

    it('returns 401 when the request is not authorized', async () => {
      vi.doMock('../../src/modules/findings/tenant-auth.js', () => ({
        resolveAuthorizedTenantContext: vi.fn().mockResolvedValue(null),
      }));
      const listGateFailures = vi.fn();
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/findings/list-gate-failures.js', () => ({ listGateFailures }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({ method: 'GET', url: '/api/gate-failures' });
      expect(res.statusCode).toBe(401);
      expect(listGateFailures).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /api/findings/:id/status (86e2v1xyr)', () => {
    it('returns 200 and the new status for a valid, writable status transition', async () => {
      mockAuthorized();
      const updateFindingStatus = vi.fn().mockResolvedValue({ found: true });
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/findings/update-finding-status.js', () => ({ updateFindingStatus }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/findings/f1/status',
        headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1', 'content-type': 'application/json' },
        payload: { status: 'in_review' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id: 'f1', status: 'in_review' });
      expect(updateFindingStatus).toHaveBeenCalledWith({}, 'f1', 'in_review', undefined);
    });

    it('returns 404 without calling reply with a 200 when the finding is not found for this tenant', async () => {
      mockAuthorized();
      const updateFindingStatus = vi.fn().mockResolvedValue({ found: false });
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/findings/update-finding-status.js', () => ({ updateFindingStatus }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/findings/missing/status',
        headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1', 'content-type': 'application/json' },
        payload: { status: 'in_review' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 401 when unauthorized, without ever calling updateFindingStatus', async () => {
      vi.doMock('../../src/modules/findings/tenant-auth.js', () => ({
        resolveAuthorizedTenantContext: vi.fn().mockResolvedValue(null),
      }));
      const updateFindingStatus = vi.fn();
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/findings/update-finding-status.js', () => ({ updateFindingStatus }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/findings/f1/status',
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
      }));
      vi.doMock('../../src/modules/findings/update-finding-status.js', () => ({ updateFindingStatus }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/findings/f1/status',
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
      }));
      vi.doMock('../../src/modules/findings/update-finding-status.js', () => ({ updateFindingStatus }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      await app.inject({
        method: 'PATCH',
        url: '/api/findings/f1/status',
        headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1', 'content-type': 'application/json' },
        payload: { status: 'closed', note: 'analyst note' },
      });
      expect(updateFindingStatus).toHaveBeenCalledWith({}, 'f1', 'closed', 'analyst note');
    });
  });
});
