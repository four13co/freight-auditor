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
});
