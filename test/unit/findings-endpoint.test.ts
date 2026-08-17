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

  // 86e2v24ye: status/min-amount are interpolated into a query with no
  // validation -- a malformed value throws a raw Postgres error, and app.ts
  // registers no setErrorHandler, so Fastify's default handler reflects that
  // error (including query/stack detail) into the 500 response body. These
  // never reach listFindings/the DB -- validation happens before that call.
  describe('86e2v24ye: query param validation (never reaches the DB on bad input)', () => {
    it('an invalid status value returns 400 with a clean message, not a raw Postgres error', async () => {
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
      expect(res.json()).toHaveProperty('error');
      // Never touches the DB layer -- validation rejects before that call.
      expect(listFindings).not.toHaveBeenCalled();
    });

    it('every real variance_status value is accepted', async () => {
      mockAuthorized();
      const listFindings = vi.fn().mockResolvedValue([]);
      vi.doMock('../../src/db/tenant-context.js', () => ({
        withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
      }));
      vi.doMock('../../src/modules/findings/list-findings.js', () => ({ listFindings }));
      const { buildApp } = await import('../../src/server/app.js');
      app = buildApp();

      for (const status of [
        'open', 'in_review', 'accepted', 'waived',
        'queued_for_dispute', 'disputed', 'recovered', 'written_off', 'closed',
      ]) {
        const res = await app.inject({
          method: 'GET',
          url: `/api/findings?status=${status}`,
          headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' },
        });
        expect(res.statusCode).toBe(200);
      }
    });

    it('a non-numeric min-amount returns 400, not a 500 with PG error detail', async () => {
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
      expect(res.json()).toHaveProperty('error');
      expect(listFindings).not.toHaveBeenCalled();
    });

    it('a numeric min-amount (including decimals) is accepted', async () => {
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
        url: '/api/findings?min-amount=150.50',
        headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('absent status/min-amount are still accepted (validation only fires when a value is present)', async () => {
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
        url: '/api/findings',
        headers: { 'x-client-id': 'client-abc', 'x-user-id': 'user-1' },
      });
      expect(res.statusCode).toBe(200);
    });
  });
});
