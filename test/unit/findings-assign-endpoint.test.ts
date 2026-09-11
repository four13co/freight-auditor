import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// 86e37r2t8: same mock shape as findings-reverse-endpoint.test.ts -- both
// routes are gated by registerAnalystOnlyPreHandler (actorRole check), and
// unlike findings-endpoint.test.ts's own mockTenantAuth (which mocks
// registerAnalystOnlyPreHandler as a no-op, since none of ITS routes need
// the role gate enforced), this file needs the real 403 behavior wired.
function mockTenantAuth(resolvedContext: unknown, role: string = 'analyst', actorUserId: string = 'user-1') {
  vi.doMock('../../src/modules/findings/tenant-auth.js', () => ({
    resolveAuthorizedTenantContext: vi.fn().mockResolvedValue(resolvedContext),
    registerTenantAuthPreHandler: async (routes: FastifyInstance) => {
      routes.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
        if (!resolvedContext) {
          await reply.code(401).send({ error: 'unauthorized' });
          return;
        }
        request.tenantContext = resolvedContext as FastifyRequest['tenantContext'];
        request.actorRole = role;
        request.actorUserId = actorUserId;
      });
    },
    registerAnalystOnlyPreHandler: async (routes: FastifyInstance) => {
      routes.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
        if (request.actorRole !== 'analyst' && request.actorRole !== 'lead') {
          await reply.code(403).send({ error: 'internal analyst role required' });
        }
      });
    },
  }));
}

const FINDING_ID = '11111111-2222-3333-4444-555555555555';

/**
 * 86e37r2t8: request-level coverage of the new PATCH /api/findings/:id/assign
 * route, mocked at the outermost boundary (withTenantTx's client + the
 * assignFinding module), same mock-depth convention
 * findings-reverse-endpoint.test.ts already established for this file's
 * sibling analyst-only-gated route.
 */
describe('PATCH /api/findings/:id/assign (unit, mocked withTenantTx + tenant-auth + assignFinding)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.resetModules();
    vi.doUnmock('../../src/db/tenant-context.js');
    vi.doUnmock('../../src/modules/findings/tenant-auth.js');
    vi.doUnmock('../../src/modules/findings/assign-finding.js');
  });

  function mockAuthorized(role: string = 'analyst', actorUserId: string = 'user-1') {
    mockTenantAuth({ clientIds: ['client-abc'], internal: false }, role, actorUserId);
  }

  it('AC1: assigns to the caller\'s own actorUserId when userId is a non-null string', async () => {
    mockAuthorized('analyst', 'user-1');
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const assignFinding = vi.fn().mockResolvedValue({ found: true });
    vi.doMock('../../src/modules/findings/assign-finding.js', () => ({ assignFinding }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({
      method: 'PATCH', url: `/api/findings/${FINDING_ID}/assign`,
      payload: { userId: 'user-1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: FINDING_ID, assignedToUserId: 'user-1' });
    expect(assignFinding).toHaveBeenCalledWith(expect.anything(), FINDING_ID, 'user-1', 'user-1');
  });

  it('ignores a client-supplied userId value that is NOT the caller\'s own -- always assigns to actorUserId', async () => {
    mockAuthorized('analyst', 'user-1');
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const assignFinding = vi.fn().mockResolvedValue({ found: true });
    vi.doMock('../../src/modules/findings/assign-finding.js', () => ({ assignFinding }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({
      method: 'PATCH', url: `/api/findings/${FINDING_ID}/assign`,
      // "someone-elses-id" is a decoy -- the route must never use it as the assignee.
      payload: { userId: 'someone-elses-id' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: FINDING_ID, assignedToUserId: 'user-1' });
    expect(assignFinding).toHaveBeenCalledWith(expect.anything(), FINDING_ID, 'user-1', 'user-1');
  });

  it('unassigns when userId is null', async () => {
    mockAuthorized('analyst', 'user-1');
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const assignFinding = vi.fn().mockResolvedValue({ found: true });
    vi.doMock('../../src/modules/findings/assign-finding.js', () => ({ assignFinding }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({
      method: 'PATCH', url: `/api/findings/${FINDING_ID}/assign`,
      payload: { userId: null },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: FINDING_ID, assignedToUserId: null });
    expect(assignFinding).toHaveBeenCalledWith(expect.anything(), FINDING_ID, null, 'user-1');
  });

  it('returns 404 when the finding does not exist', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const assignFinding = vi.fn().mockResolvedValue({ found: false });
    vi.doMock('../../src/modules/findings/assign-finding.js', () => ({ assignFinding }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({
      method: 'PATCH', url: `/api/findings/${FINDING_ID}/assign`,
      payload: { userId: 'user-1' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a malformed finding id with 400, without calling assignFinding', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const assignFinding = vi.fn();
    vi.doMock('../../src/modules/findings/assign-finding.js', () => ({ assignFinding }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({
      method: 'PATCH', url: '/api/findings/not-a-uuid/assign',
      payload: { userId: 'user-1' },
    });
    expect(res.statusCode).toBe(400);
    expect(assignFinding).not.toHaveBeenCalled();
  });

  it('rejects a non-string, non-null userId with 400, without calling assignFinding', async () => {
    mockAuthorized();
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const assignFinding = vi.fn();
    vi.doMock('../../src/modules/findings/assign-finding.js', () => ({ assignFinding }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({
      method: 'PATCH', url: `/api/findings/${FINDING_ID}/assign`,
      payload: { userId: 12345 },
    });
    expect(res.statusCode).toBe(400);
    expect(assignFinding).not.toHaveBeenCalled();
  });

  // 86e37r2t8 AC4
  it('AC4: rejects a client_viewer (portal) session with 403, without calling assignFinding', async () => {
    mockAuthorized('client_viewer');
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const assignFinding = vi.fn();
    vi.doMock('../../src/modules/findings/assign-finding.js', () => ({ assignFinding }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({
      method: 'PATCH', url: `/api/findings/${FINDING_ID}/assign`,
      payload: { userId: 'user-1' },
    });
    expect(res.statusCode).toBe(403);
    expect(assignFinding).not.toHaveBeenCalled();
  });

  it('AC4: rejects a client_admin (portal) session with 403, without calling assignFinding', async () => {
    mockAuthorized('client_admin');
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const assignFinding = vi.fn();
    vi.doMock('../../src/modules/findings/assign-finding.js', () => ({ assignFinding }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({
      method: 'PATCH', url: `/api/findings/${FINDING_ID}/assign`,
      payload: { userId: 'user-1' },
    });
    expect(res.statusCode).toBe(403);
    expect(assignFinding).not.toHaveBeenCalled();
  });

  it('lets a lead assign a finding through, same as analyst', async () => {
    mockAuthorized('lead', 'lead-user-1');
    vi.doMock('../../src/db/tenant-context.js', () => ({
      withTenantTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})),
    }));
    const assignFinding = vi.fn().mockResolvedValue({ found: true });
    vi.doMock('../../src/modules/findings/assign-finding.js', () => ({ assignFinding }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({
      method: 'PATCH', url: `/api/findings/${FINDING_ID}/assign`,
      payload: { userId: 'lead-user-1' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects an unauthenticated request with 401, without calling assignFinding', async () => {
    mockTenantAuth(null);
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx: vi.fn() }));
    const assignFinding = vi.fn();
    vi.doMock('../../src/modules/findings/assign-finding.js', () => ({ assignFinding }));
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({
      method: 'PATCH', url: `/api/findings/${FINDING_ID}/assign`,
      payload: { userId: 'user-1' },
    });
    expect(res.statusCode).toBe(401);
    expect(assignFinding).not.toHaveBeenCalled();
  });
});
