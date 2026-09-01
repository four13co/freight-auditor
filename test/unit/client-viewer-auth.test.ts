import { describe, it, expect, vi, afterEach } from 'vitest';
import type { FastifyRequest } from 'fastify';

/**
 * Unit coverage of resolveClientViewerContext's header/session-gating and
 * role logic via a mocked withTenantTx -- no live DB. The real
 * membership.role lookup against real Postgres, plus the RLS proof that a
 * non-client_viewer role can't see rows through this scope, is covered by
 * test/db/client-viewer-auth.db.test.ts.
 *
 * Structured to mirror test/unit/internal-analyst-auth.test.ts's own shape
 * (itself mirroring tenant-auth.test.ts) -- this is another isolated
 * resolver, per client-viewer-auth.ts's own header comment on why it does
 * not reuse tenant-auth.ts's or internal-analyst-auth.ts's resolvers.
 */
function mockRequest(
  headers: Record<string, string | string[] | undefined>,
  method = 'GET',
): FastifyRequest {
  return { headers, method } as unknown as FastifyRequest;
}

describe('resolveClientViewerContext (DEV_AUTH_HEADERS set)', () => {
  let originalFlag: string | undefined;

  const setup = () => {
    originalFlag = process.env.DEV_AUTH_HEADERS;
    process.env.DEV_AUTH_HEADERS = '1';
  };

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.DEV_AUTH_HEADERS;
    else process.env.DEV_AUTH_HEADERS = originalFlag;
    vi.doUnmock('../../src/db/tenant-context.js');
    vi.resetModules();
  });

  it('returns null when x-client-id is missing, without querying the DB', async () => {
    setup();
    const withTenantTx = vi.fn();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveClientViewerContext } = await import('../../src/modules/identity/client-viewer-auth.js');

    const ctx = await resolveClientViewerContext(mockRequest({ 'x-user-id': 'user-1' }));
    expect(ctx).toBeNull();
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('returns null when x-user-id is missing, without querying the DB', async () => {
    setup();
    const withTenantTx = vi.fn();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveClientViewerContext } = await import('../../src/modules/identity/client-viewer-auth.js');

    const ctx = await resolveClientViewerContext(mockRequest({ 'x-client-id': 'client-1' }));
    expect(ctx).toBeNull();
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('grants { clientIds: [clientId], internal: false } under an internal-scoped transaction when the role is client_viewer', async () => {
    setup();
    const query = vi.fn().mockResolvedValue({ rows: [{ role: 'client_viewer' }] });
    const withTenantTx = vi.fn(async (ctx, fn) => fn({ query }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveClientViewerContext } = await import('../../src/modules/identity/client-viewer-auth.js');

    const ctx = await resolveClientViewerContext(mockRequest({ 'x-client-id': 'client-1', 'x-user-id': 'user-1' }));

    expect(withTenantTx).toHaveBeenCalledWith({ internal: true }, expect.any(Function));
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM membership'), ['user-1', 'client-1']);
    expect(ctx).toEqual({ clientIds: ['client-1'], internal: false });
  });

  it('returns null when the membership role is client_admin -- a sibling capability, out of scope here', async () => {
    setup();
    const query = vi.fn().mockResolvedValue({ rows: [{ role: 'client_admin' }] });
    const withTenantTx = vi.fn(async (_ctx, fn) => fn({ query }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveClientViewerContext } = await import('../../src/modules/identity/client-viewer-auth.js');

    const ctx = await resolveClientViewerContext(mockRequest({ 'x-client-id': 'client-1', 'x-user-id': 'user-1' }));
    expect(ctx).toBeNull();
  });

  it('returns null when the membership role is an internal role (analyst/lead)', async () => {
    setup();
    const query = vi.fn().mockResolvedValue({ rows: [{ role: 'analyst' }] });
    const withTenantTx = vi.fn(async (_ctx, fn) => fn({ query }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveClientViewerContext } = await import('../../src/modules/identity/client-viewer-auth.js');

    const ctx = await resolveClientViewerContext(mockRequest({ 'x-client-id': 'client-1', 'x-user-id': 'user-1' }));
    expect(ctx).toBeNull();
  });

  it('returns null when there is no membership row for the user+client pair', async () => {
    setup();
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const withTenantTx = vi.fn(async (_ctx, fn) => fn({ query }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveClientViewerContext } = await import('../../src/modules/identity/client-viewer-auth.js');

    const ctx = await resolveClientViewerContext(mockRequest({ 'x-client-id': 'client-1', 'x-user-id': 'user-1' }));
    expect(ctx).toBeNull();
  });

  it('takes the first value when x-client-id/x-user-id are sent multiple times', async () => {
    setup();
    const query = vi.fn().mockResolvedValue({ rows: [{ role: 'client_viewer' }] });
    const withTenantTx = vi.fn(async (_ctx, fn) => fn({ query }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveClientViewerContext } = await import('../../src/modules/identity/client-viewer-auth.js');

    await resolveClientViewerContext(
      mockRequest({ 'x-client-id': ['client-a', 'client-b'], 'x-user-id': ['user-a', 'user-b'] }),
    );
    expect(query).toHaveBeenCalledWith(expect.any(String), ['user-a', 'client-a']);
  });
});

/**
 * The prod-default path. Mirrors internal-analyst-auth.test.ts's own
 * "DEV_AUTH_HEADERS unset" block: a header-only bypass must not survive
 * without DEV_AUTH_HEADERS explicitly set, and a genuine backend fault while
 * resolving a real session must propagate (500), not collapse into a
 * silent 401.
 */
describe('resolveClientViewerContext (DEV_AUTH_HEADERS unset -- the prod default)', () => {
  let originalFlag: string | undefined;

  const setup = () => {
    originalFlag = process.env.DEV_AUTH_HEADERS;
    delete process.env.DEV_AUTH_HEADERS;
  };

  afterEach(() => {
    if (originalFlag !== undefined) process.env.DEV_AUTH_HEADERS = originalFlag;
    vi.doUnmock('../../src/auth/better-auth.js');
    vi.doUnmock('../../src/db/tenant-context.js');
    vi.resetModules();
  });

  it('rejects dev headers alone, without a session cookie -- never touches auth or the DB', async () => {
    setup();
    const getSession = vi.fn();
    const withTenantTx = vi.fn();
    vi.doMock('../../src/auth/better-auth.js', () => ({ getAuth: () => ({ api: { getSession } }) }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveClientViewerContext } = await import('../../src/modules/identity/client-viewer-auth.js');

    const ctx = await resolveClientViewerContext(
      mockRequest({ 'x-client-id': 'client-1', 'x-user-id': 'user-1' }),
    );
    expect(ctx).toBeNull();
    expect(getSession).not.toHaveBeenCalled();
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('rejects a request with no cookie at all, without touching auth or the DB', async () => {
    setup();
    const getSession = vi.fn();
    const withTenantTx = vi.fn();
    vi.doMock('../../src/auth/better-auth.js', () => ({ getAuth: () => ({ api: { getSession } }) }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveClientViewerContext } = await import('../../src/modules/identity/client-viewer-auth.js');

    const ctx = await resolveClientViewerContext(mockRequest({}));
    expect(ctx).toBeNull();
    expect(getSession).not.toHaveBeenCalled();
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('rejects a cookie that resolves to no valid session', async () => {
    setup();
    const getSession = vi.fn().mockResolvedValue(null);
    const withTenantTx = vi.fn();
    vi.doMock('../../src/auth/better-auth.js', () => ({ getAuth: () => ({ api: { getSession } }) }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveClientViewerContext } = await import('../../src/modules/identity/client-viewer-auth.js');

    const ctx = await resolveClientViewerContext(
      mockRequest({ cookie: 'better-auth.session_token=stale', 'x-client-id': 'client-1' }),
    );
    expect(ctx).toBeNull();
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('rejects a valid session with no x-client-id header, without querying the DB', async () => {
    setup();
    const getSession = vi.fn().mockResolvedValue({ user: { id: 'session-user-1' }, session: {} });
    const withTenantTx = vi.fn();
    vi.doMock('../../src/auth/better-auth.js', () => ({ getAuth: () => ({ api: { getSession } }) }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveClientViewerContext } = await import('../../src/modules/identity/client-viewer-auth.js');

    const ctx = await resolveClientViewerContext(mockRequest({ cookie: 'better-auth.session_token=valid' }));
    expect(ctx).toBeNull();
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('resolves via a verified session + a client_viewer membership row', async () => {
    setup();
    const getSession = vi.fn().mockResolvedValue({ user: { id: 'session-user-1' }, session: {} });
    const query = vi.fn().mockResolvedValue({ rows: [{ role: 'client_viewer' }] });
    const withTenantTx = vi.fn(async (_ctx, fn) => fn({ query }));
    vi.doMock('../../src/auth/better-auth.js', () => ({ getAuth: () => ({ api: { getSession } }) }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveClientViewerContext } = await import('../../src/modules/identity/client-viewer-auth.js');

    const ctx = await resolveClientViewerContext(
      mockRequest({ cookie: 'better-auth.session_token=valid', 'x-client-id': 'client-1' }),
    );

    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM membership'), ['session-user-1', 'client-1']);
    expect(ctx).toEqual({ clientIds: ['client-1'], internal: false });
  });

  it('rejects a valid session whose membership role is client_admin', async () => {
    setup();
    const getSession = vi.fn().mockResolvedValue({ user: { id: 'session-user-1' }, session: {} });
    const query = vi.fn().mockResolvedValue({ rows: [{ role: 'client_admin' }] });
    const withTenantTx = vi.fn(async (_ctx, fn) => fn({ query }));
    vi.doMock('../../src/auth/better-auth.js', () => ({ getAuth: () => ({ api: { getSession } }) }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveClientViewerContext } = await import('../../src/modules/identity/client-viewer-auth.js');

    const ctx = await resolveClientViewerContext(
      mockRequest({ cookie: 'better-auth.session_token=valid', 'x-client-id': 'client-1' }),
    );
    expect(ctx).toBeNull();
  });

  it('propagates (does not swallow) a genuine backend error when a cookie IS present', async () => {
    setup();
    const getSession = vi.fn().mockRejectedValue(new Error('DATABASE_URL is not set'));
    vi.doMock('../../src/auth/better-auth.js', () => ({ getAuth: () => ({ api: { getSession } }) }));
    const { resolveClientViewerContext } = await import('../../src/modules/identity/client-viewer-auth.js');

    await expect(
      resolveClientViewerContext(mockRequest({ cookie: 'better-auth.session_token=valid', 'x-client-id': 'client-1' })),
    ).rejects.toThrow('DATABASE_URL is not set');
  });
});

describe.each(['0', 'false'])('resolveClientViewerContext (DEV_AUTH_HEADERS=%s)', (flag) => {
  const originalFlag = process.env.DEV_AUTH_HEADERS;

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.DEV_AUTH_HEADERS;
    else process.env.DEV_AUTH_HEADERS = originalFlag;
    vi.doUnmock('../../src/auth/better-auth.js');
    vi.doUnmock('../../src/db/tenant-context.js');
    vi.resetModules();
  });

  it('uses the real-session path instead of trusting the dev headers', async () => {
    process.env.DEV_AUTH_HEADERS = flag;
    const getSession = vi.fn();
    const withTenantTx = vi.fn();
    vi.doMock('../../src/auth/better-auth.js', () => ({ getAuth: () => ({ api: { getSession } }) }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveClientViewerContext } = await import('../../src/modules/identity/client-viewer-auth.js');

    const ctx = await resolveClientViewerContext(mockRequest({ 'x-client-id': 'client-1', 'x-user-id': 'user-1' }));
    expect(ctx).toBeNull();
    expect(withTenantTx).not.toHaveBeenCalled();
  });
});

/**
 * registerClientViewerAuthPreHandler's own body, exercised through a real
 * Fastify instance -- mocking resolveClientViewerContext from outside would
 * NOT exercise this function's real body (same same-module-call ESM
 * self-reference pitfall documented on tenant-auth.test.ts's own
 * registerTenantAuthPreHandler suite), so withTenantTx is mocked instead,
 * the same seam every describe block above already uses.
 */
describe('registerClientViewerAuthPreHandler', () => {
  let originalFlag: string | undefined;

  const setup = () => {
    originalFlag = process.env.DEV_AUTH_HEADERS;
    process.env.DEV_AUTH_HEADERS = '1';
  };

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.DEV_AUTH_HEADERS;
    else process.env.DEV_AUTH_HEADERS = originalFlag;
    vi.doUnmock('../../src/db/tenant-context.js');
    vi.resetModules();
  });

  it('sets tenantContext + clientPortalReadOnly and lets a GET through for a client_viewer', async () => {
    setup();
    const query = vi.fn().mockResolvedValue({ rows: [{ role: 'client_viewer' }] });
    const withTenantTx = vi.fn(async (_ctx: unknown, fn: (client: { query: typeof query }) => unknown) => fn({ query }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { registerClientViewerAuthPreHandler } = await import('../../src/modules/identity/client-viewer-auth.js');
    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    await registerClientViewerAuthPreHandler(app);
    app.get('/probe', async (request) => ({
      tenantContext: request.tenantContext,
      readOnly: request.clientPortalReadOnly,
    }));

    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-client-id': 'client-1', 'x-user-id': 'user-1' },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ tenantContext: { clientIds: ['client-1'], internal: false }, readOnly: true });
    await app.close();
  });

  it('lets a HEAD request through too', async () => {
    setup();
    const query = vi.fn().mockResolvedValue({ rows: [{ role: 'client_viewer' }] });
    const withTenantTx = vi.fn(async (_ctx: unknown, fn: (client: { query: typeof query }) => unknown) => fn({ query }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { registerClientViewerAuthPreHandler } = await import('../../src/modules/identity/client-viewer-auth.js');
    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    await registerClientViewerAuthPreHandler(app);
    app.get('/probe', async () => ({ ok: true }));

    const res = await app.inject({
      method: 'HEAD',
      url: '/probe',
      headers: { 'x-client-id': 'client-1', 'x-user-id': 'user-1' },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('replies 403 for a POST from a valid client_viewer -- read-only enforced before the handler runs', async () => {
    setup();
    const query = vi.fn().mockResolvedValue({ rows: [{ role: 'client_viewer' }] });
    const withTenantTx = vi.fn(async (_ctx: unknown, fn: (client: { query: typeof query }) => unknown) => fn({ query }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { registerClientViewerAuthPreHandler } = await import('../../src/modules/identity/client-viewer-auth.js');
    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    const handler = vi.fn().mockResolvedValue({ ok: true });
    await registerClientViewerAuthPreHandler(app);
    app.post('/probe', handler);

    const res = await app.inject({
      method: 'POST',
      url: '/probe',
      headers: { 'x-client-id': 'client-1', 'x-user-id': 'user-1' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'client_viewer is read-only' });
    expect(handler).not.toHaveBeenCalled();
    await app.close();
  });

  it('replies 401 (not 403) for a POST with no valid client_viewer identity at all', async () => {
    setup();
    const withTenantTx = vi.fn();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { registerClientViewerAuthPreHandler } = await import('../../src/modules/identity/client-viewer-auth.js');
    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    const handler = vi.fn().mockResolvedValue({ ok: true });
    await registerClientViewerAuthPreHandler(app);
    app.post('/probe', handler);

    const res = await app.inject({ method: 'POST', url: '/probe' });

    expect(res.statusCode).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    await app.close();
  });

  it('replies 401 and never reaches the route handler for a client_admin caller', async () => {
    setup();
    const query = vi.fn().mockResolvedValue({ rows: [{ role: 'client_admin' }] });
    const withTenantTx = vi.fn(async (_ctx: unknown, fn: (client: { query: typeof query }) => unknown) => fn({ query }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { registerClientViewerAuthPreHandler } = await import('../../src/modules/identity/client-viewer-auth.js');
    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    const handler = vi.fn().mockResolvedValue({ ok: true });
    await registerClientViewerAuthPreHandler(app);
    app.get('/probe', handler);

    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-client-id': 'client-1', 'x-user-id': 'user-1' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
    expect(handler).not.toHaveBeenCalled();
    await app.close();
  });

  it('replies 401 for a request with no identity at all', async () => {
    setup();
    const withTenantTx = vi.fn();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { registerClientViewerAuthPreHandler } = await import('../../src/modules/identity/client-viewer-auth.js');
    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    const handler = vi.fn().mockResolvedValue({ ok: true });
    await registerClientViewerAuthPreHandler(app);
    app.get('/probe', handler);

    const res = await app.inject({ method: 'GET', url: '/probe' });

    expect(res.statusCode).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    await app.close();
  });
});
