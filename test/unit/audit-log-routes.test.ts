import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { buildApp } from '../../src/server/app.js';

function mockAuth() {
  vi.doMock('../../src/modules/findings/internal-analyst-auth.js', () => ({
    registerInternalAnalystAuthPreHandler: async (routes: FastifyInstance) => {
      routes.addHook('preHandler', async (request: FastifyRequest, _reply: FastifyReply) => {
        request.tenantContext = { internal: true };
      });
    },
  }));
}

describe('audit log routes', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.resetModules();
  });

  it('requires internal-analyst authorization before returning the audit log', async () => {
    app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/internal/audit-log' });
    expect(response.statusCode).toBe(401);
  });

  it('does not grant access via the shared tenant-auth preHandler -- a single-client context alone is not internal', async () => {
    app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/internal/audit-log',
      headers: { 'x-client-id': '11111111-1111-4111-8111-111111111111', 'x-user-id': '22222222-2222-4222-8222-222222222222' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns { events } for an authorized request, with no filters threaded through', async () => {
    mockAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})) }));
    const events = [{ id: 'e1', entity: 'dispute', entityId: 'd1', event: 'created', actorKind: 'analyst', recordedAt: '2026-01-01T00:00:00.000Z' }];
    const listInternalAuditEvents = vi.fn().mockResolvedValue(events);
    vi.doMock('../../src/modules/audit-ledger/list-internal-audit-events.js', () => ({ listInternalAuditEvents }));
    const { registerAuditLogRoutes } = await import('../../src/server/audit-log-routes.js');
    app = Fastify();
    await app.register(registerAuditLogRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/internal/audit-log' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ events });
    expect(listInternalAuditEvents).toHaveBeenCalledWith({}, {
      entity: undefined, event: undefined, from: undefined, to: undefined, limit: undefined, offset: undefined,
    });
  });

  it('returns 200 with an empty events array when no audit events exist yet', async () => {
    mockAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})) }));
    vi.doMock('../../src/modules/audit-ledger/list-internal-audit-events.js', () => ({ listInternalAuditEvents: vi.fn().mockResolvedValue([]) }));
    const { registerAuditLogRoutes } = await import('../../src/server/audit-log-routes.js');
    app = Fastify();
    await app.register(registerAuditLogRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/internal/audit-log' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ events: [] });
  });

  it('threads entity/event/from/to/limit/offset query params through to listInternalAuditEvents', async () => {
    mockAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: unknown) => unknown) => fn({})) }));
    const listInternalAuditEvents = vi.fn().mockResolvedValue([]);
    vi.doMock('../../src/modules/audit-ledger/list-internal-audit-events.js', () => ({ listInternalAuditEvents }));
    const { registerAuditLogRoutes } = await import('../../src/server/audit-log-routes.js');
    app = Fastify();
    await app.register(registerAuditLogRoutes);
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/api/internal/audit-log?entity=dispute&event=created&from=2026-01-01T00%3A00%3A00Z&to=2026-02-01T00%3A00%3A00Z&limit=10&offset=20',
    });

    expect(response.statusCode).toBe(200);
    expect(listInternalAuditEvents).toHaveBeenCalledWith({}, {
      entity: 'dispute',
      event: 'created',
      from: new Date('2026-01-01T00:00:00Z'),
      to: new Date('2026-02-01T00:00:00Z'),
      limit: 10,
      offset: 20,
    });
  });

  it('rejects an invalid entity query param with 400, without calling listInternalAuditEvents', async () => {
    mockAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantReadTx: vi.fn() }));
    const listInternalAuditEvents = vi.fn();
    vi.doMock('../../src/modules/audit-ledger/list-internal-audit-events.js', () => ({ listInternalAuditEvents }));
    const { registerAuditLogRoutes } = await import('../../src/server/audit-log-routes.js');
    app = Fastify();
    await app.register(registerAuditLogRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/internal/audit-log?entity=NotValid!' });
    expect(response.statusCode).toBe(400);
    expect(listInternalAuditEvents).not.toHaveBeenCalled();
  });

  it('rejects an invalid event query param with 400, without calling listInternalAuditEvents', async () => {
    mockAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantReadTx: vi.fn() }));
    const listInternalAuditEvents = vi.fn();
    vi.doMock('../../src/modules/audit-ledger/list-internal-audit-events.js', () => ({ listInternalAuditEvents }));
    const { registerAuditLogRoutes } = await import('../../src/server/audit-log-routes.js');
    app = Fastify();
    await app.register(registerAuditLogRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/internal/audit-log?event=NotValid!' });
    expect(response.statusCode).toBe(400);
    expect(listInternalAuditEvents).not.toHaveBeenCalled();
  });

  it('rejects an unparseable from date with 400, without calling listInternalAuditEvents', async () => {
    mockAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantReadTx: vi.fn() }));
    const listInternalAuditEvents = vi.fn();
    vi.doMock('../../src/modules/audit-ledger/list-internal-audit-events.js', () => ({ listInternalAuditEvents }));
    const { registerAuditLogRoutes } = await import('../../src/server/audit-log-routes.js');
    app = Fastify();
    await app.register(registerAuditLogRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/internal/audit-log?from=not-a-date' });
    expect(response.statusCode).toBe(400);
    expect(listInternalAuditEvents).not.toHaveBeenCalled();
  });

  it('rejects an unparseable to date with 400, without calling listInternalAuditEvents', async () => {
    mockAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantReadTx: vi.fn() }));
    const listInternalAuditEvents = vi.fn();
    vi.doMock('../../src/modules/audit-ledger/list-internal-audit-events.js', () => ({ listInternalAuditEvents }));
    const { registerAuditLogRoutes } = await import('../../src/server/audit-log-routes.js');
    app = Fastify();
    await app.register(registerAuditLogRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/internal/audit-log?to=not-a-date' });
    expect(response.statusCode).toBe(400);
    expect(listInternalAuditEvents).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range limit with 400', async () => {
    mockAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantReadTx: vi.fn() }));
    const listInternalAuditEvents = vi.fn();
    vi.doMock('../../src/modules/audit-ledger/list-internal-audit-events.js', () => ({ listInternalAuditEvents }));
    const { registerAuditLogRoutes } = await import('../../src/server/audit-log-routes.js');
    app = Fastify();
    await app.register(registerAuditLogRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/internal/audit-log?limit=0' });
    expect(response.statusCode).toBe(400);
    expect(listInternalAuditEvents).not.toHaveBeenCalled();
  });

  it('rejects a negative offset with 400', async () => {
    mockAuth();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantReadTx: vi.fn() }));
    const listInternalAuditEvents = vi.fn();
    vi.doMock('../../src/modules/audit-ledger/list-internal-audit-events.js', () => ({ listInternalAuditEvents }));
    const { registerAuditLogRoutes } = await import('../../src/server/audit-log-routes.js');
    app = Fastify();
    await app.register(registerAuditLogRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/internal/audit-log?offset=-1' });
    expect(response.statusCode).toBe(400);
    expect(listInternalAuditEvents).not.toHaveBeenCalled();
  });
});
