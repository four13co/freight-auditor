import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyRequest } from 'fastify';

/**
 * Unit coverage of resolveInternalAnalystContext's header/session-gating
 * logic via a mocked withTenantTx -- no live DB. The real
 * app_user.is_internal lookup against real Postgres is covered by
 * test/db/internal-analyst-auth.db.test.ts, and the RLS proof that a
 * non-internal caller can't see other clients' rows through the query this
 * auth gates is covered by test/db/get-cross-client-portfolio.db.test.ts.
 *
 * Structured to mirror test/unit/tenant-auth.test.ts's own describe blocks
 * -- this is the isolated resolver PR #247's rebuild introduces (see
 * internal-analyst-auth.ts's header comment); its test shape should look
 * exactly as unsurprising as the module it deliberately does NOT touch.
 */
function mockRequest(headers: Record<string, string | string[] | undefined>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

describe('resolveInternalAnalystContext (DEV_AUTH_HEADERS set)', () => {
  let originalFlag: string | undefined;

  beforeEach(() => {
    originalFlag = process.env.DEV_AUTH_HEADERS;
    process.env.DEV_AUTH_HEADERS = '1';
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.DEV_AUTH_HEADERS;
    else process.env.DEV_AUTH_HEADERS = originalFlag;
    vi.doUnmock('../../src/db/tenant-context.js');
    vi.resetModules();
  });

  it('returns null when x-user-id is missing, without querying the DB', async () => {
    const withTenantTx = vi.fn();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveInternalAnalystContext } = await import('../../src/modules/findings/internal-analyst-auth.js');

    const ctx = await resolveInternalAnalystContext(mockRequest({}));
    expect(ctx).toBeNull();
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('ignores x-client-id entirely -- this scope is cross-client by design, no client header is read', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ is_internal: true }] });
    const withTenantTx = vi.fn(async (ctx, fn) => fn({ query }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveInternalAnalystContext } = await import('../../src/modules/findings/internal-analyst-auth.js');

    const ctx = await resolveInternalAnalystContext(mockRequest({ 'x-user-id': 'user-1', 'x-client-id': 'client-1' }));
    expect(ctx).toEqual({ internal: true });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM app_user'), ['user-1']);
  });

  it('grants { internal: true } (no clientIds) under an internal-scoped transaction when app_user.is_internal is true', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ is_internal: true }] });
    const withTenantTx = vi.fn(async (ctx, fn) => fn({ query }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveInternalAnalystContext } = await import('../../src/modules/findings/internal-analyst-auth.js');

    const ctx = await resolveInternalAnalystContext(mockRequest({ 'x-user-id': 'user-1' }));

    expect(withTenantTx).toHaveBeenCalledWith({ internal: true }, expect.any(Function));
    expect(ctx).toEqual({ internal: true });
  });

  it('returns null when app_user.is_internal is false -- a normal client user cannot reach this scope', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ is_internal: false }] });
    const withTenantTx = vi.fn(async (_ctx, fn) => fn({ query }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveInternalAnalystContext } = await import('../../src/modules/findings/internal-analyst-auth.js');

    const ctx = await resolveInternalAnalystContext(mockRequest({ 'x-user-id': 'user-1' }));
    expect(ctx).toBeNull();
  });

  it('returns null when the user id does not resolve to any app_user row', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const withTenantTx = vi.fn(async (_ctx, fn) => fn({ query }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveInternalAnalystContext } = await import('../../src/modules/findings/internal-analyst-auth.js');

    const ctx = await resolveInternalAnalystContext(mockRequest({ 'x-user-id': 'user-1' }));
    expect(ctx).toBeNull();
  });

  it('takes the first value when x-user-id is sent multiple times', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ is_internal: true }] });
    const withTenantTx = vi.fn(async (_ctx, fn) => fn({ query }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveInternalAnalystContext } = await import('../../src/modules/findings/internal-analyst-auth.js');

    await resolveInternalAnalystContext(mockRequest({ 'x-user-id': ['user-a', 'user-b'] }));
    expect(query).toHaveBeenCalledWith(expect.any(String), ['user-a']);
  });
});

/**
 * The prod-default path. Mirrors tenant-auth.test.ts's own
 * "DEV_AUTH_HEADERS unset" block: a header-only bypass must not survive
 * without DEV_AUTH_HEADERS explicitly set, and a genuine backend fault
 * while resolving a real session must propagate (500), not collapse into a
 * silent 401.
 */
describe('resolveInternalAnalystContext (DEV_AUTH_HEADERS unset -- the prod default)', () => {
  let originalFlag: string | undefined;

  beforeEach(() => {
    originalFlag = process.env.DEV_AUTH_HEADERS;
    delete process.env.DEV_AUTH_HEADERS;
  });

  afterEach(() => {
    if (originalFlag !== undefined) process.env.DEV_AUTH_HEADERS = originalFlag;
    vi.doUnmock('../../src/auth/better-auth.js');
    vi.doUnmock('../../src/db/tenant-context.js');
    vi.resetModules();
  });

  it('rejects the dev x-user-id header alone, without a session cookie -- never touches auth or the DB', async () => {
    const getSession = vi.fn();
    const withTenantTx = vi.fn();
    vi.doMock('../../src/auth/better-auth.js', () => ({ getAuth: () => ({ api: { getSession } }) }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveInternalAnalystContext } = await import('../../src/modules/findings/internal-analyst-auth.js');

    const ctx = await resolveInternalAnalystContext(mockRequest({ 'x-user-id': 'user-1' }));
    expect(ctx).toBeNull();
    expect(getSession).not.toHaveBeenCalled();
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('rejects a request with no cookie at all, without touching auth or the DB', async () => {
    const getSession = vi.fn();
    const withTenantTx = vi.fn();
    vi.doMock('../../src/auth/better-auth.js', () => ({ getAuth: () => ({ api: { getSession } }) }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveInternalAnalystContext } = await import('../../src/modules/findings/internal-analyst-auth.js');

    const ctx = await resolveInternalAnalystContext(mockRequest({}));
    expect(ctx).toBeNull();
    expect(getSession).not.toHaveBeenCalled();
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('rejects a cookie that resolves to no valid session', async () => {
    const getSession = vi.fn().mockResolvedValue(null);
    const withTenantTx = vi.fn();
    vi.doMock('../../src/auth/better-auth.js', () => ({ getAuth: () => ({ api: { getSession } }) }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveInternalAnalystContext } = await import('../../src/modules/findings/internal-analyst-auth.js');

    const ctx = await resolveInternalAnalystContext(mockRequest({ cookie: 'better-auth.session_token=stale' }));
    expect(ctx).toBeNull();
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('resolves via a verified session + is_internal=true row', async () => {
    const getSession = vi.fn().mockResolvedValue({ user: { id: 'session-user-1' }, session: {} });
    const query = vi.fn().mockResolvedValue({ rows: [{ is_internal: true }] });
    const withTenantTx = vi.fn(async (_ctx, fn) => fn({ query }));
    vi.doMock('../../src/auth/better-auth.js', () => ({ getAuth: () => ({ api: { getSession } }) }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveInternalAnalystContext } = await import('../../src/modules/findings/internal-analyst-auth.js');

    const ctx = await resolveInternalAnalystContext(mockRequest({ cookie: 'better-auth.session_token=valid' }));

    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM app_user'), ['session-user-1']);
    expect(ctx).toEqual({ internal: true });
  });

  it('rejects a valid session for a user whose app_user.is_internal is false', async () => {
    const getSession = vi.fn().mockResolvedValue({ user: { id: 'session-user-1' }, session: {} });
    const query = vi.fn().mockResolvedValue({ rows: [{ is_internal: false }] });
    const withTenantTx = vi.fn(async (_ctx, fn) => fn({ query }));
    vi.doMock('../../src/auth/better-auth.js', () => ({ getAuth: () => ({ api: { getSession } }) }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveInternalAnalystContext } = await import('../../src/modules/findings/internal-analyst-auth.js');

    const ctx = await resolveInternalAnalystContext(mockRequest({ cookie: 'better-auth.session_token=valid' }));
    expect(ctx).toBeNull();
  });

  it('propagates (does not swallow) a genuine backend error when a cookie IS present', async () => {
    const getSession = vi.fn().mockRejectedValue(new Error('DATABASE_URL is not set'));
    vi.doMock('../../src/auth/better-auth.js', () => ({ getAuth: () => ({ api: { getSession } }) }));
    const { resolveInternalAnalystContext } = await import('../../src/modules/findings/internal-analyst-auth.js');

    await expect(
      resolveInternalAnalystContext(mockRequest({ cookie: 'better-auth.session_token=valid' })),
    ).rejects.toThrow('DATABASE_URL is not set');
  });
});

describe.each(['0', 'false'])('resolveInternalAnalystContext (DEV_AUTH_HEADERS=%s)', (flag) => {
  const originalFlag = process.env.DEV_AUTH_HEADERS;

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.DEV_AUTH_HEADERS;
    else process.env.DEV_AUTH_HEADERS = originalFlag;
    vi.doUnmock('../../src/auth/better-auth.js');
    vi.doUnmock('../../src/db/tenant-context.js');
    vi.resetModules();
  });

  it('uses the real-session path instead of trusting the dev header', async () => {
    process.env.DEV_AUTH_HEADERS = flag;
    const getSession = vi.fn();
    const withTenantTx = vi.fn();
    vi.doMock('../../src/auth/better-auth.js', () => ({ getAuth: () => ({ api: { getSession } }) }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveInternalAnalystContext } = await import('../../src/modules/findings/internal-analyst-auth.js');

    const ctx = await resolveInternalAnalystContext(mockRequest({ 'x-user-id': 'user-1' }));
    expect(ctx).toBeNull();
    expect(withTenantTx).not.toHaveBeenCalled();
  });
});

/**
 * registerInternalAnalystAuthPreHandler's own body, exercised through a real
 * Fastify instance -- mocking resolveInternalAnalystContext from outside
 * would NOT exercise this function's real body (the same same-module-call
 * ESM self-reference pitfall documented on tenant-auth.test.ts's own
 * registerTenantAuthPreHandler suite), so withTenantTx is mocked instead,
 * the same seam every describe block above already uses.
 */
describe('registerInternalAnalystAuthPreHandler', () => {
  let originalFlag: string | undefined;

  beforeEach(() => {
    originalFlag = process.env.DEV_AUTH_HEADERS;
    process.env.DEV_AUTH_HEADERS = '1';
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.DEV_AUTH_HEADERS;
    else process.env.DEV_AUTH_HEADERS = originalFlag;
    vi.doUnmock('../../src/db/tenant-context.js');
    vi.resetModules();
  });

  it('sets request.tenantContext to { internal: true } and lets the request through for an internal analyst', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ is_internal: true }] });
    const withTenantTx = vi.fn(async (_ctx: unknown, fn: (client: { query: typeof query }) => unknown) => fn({ query }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { registerInternalAnalystAuthPreHandler } = await import('../../src/modules/findings/internal-analyst-auth.js');
    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    await registerInternalAnalystAuthPreHandler(app);
    app.get('/probe', async (request) => ({ tenantContext: request.tenantContext }));

    const res = await app.inject({ method: 'GET', url: '/probe', headers: { 'x-user-id': 'user-1' } });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ tenantContext: { internal: true } });
    await app.close();
  });

  it('replies 401 and never reaches the route handler for a non-internal (or unauthenticated) caller', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ is_internal: false }] });
    const withTenantTx = vi.fn(async (_ctx: unknown, fn: (client: { query: typeof query }) => unknown) => fn({ query }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { registerInternalAnalystAuthPreHandler } = await import('../../src/modules/findings/internal-analyst-auth.js');
    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    const handler = vi.fn().mockResolvedValue({ ok: true });
    await registerInternalAnalystAuthPreHandler(app);
    app.get('/probe', handler);

    const res = await app.inject({ method: 'GET', url: '/probe', headers: { 'x-user-id': 'user-1' } });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
    expect(handler).not.toHaveBeenCalled();
    await app.close();
  });

  it('replies 401 for a request with no identity at all', async () => {
    const withTenantTx = vi.fn();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { registerInternalAnalystAuthPreHandler } = await import('../../src/modules/findings/internal-analyst-auth.js');
    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    const handler = vi.fn().mockResolvedValue({ ok: true });
    await registerInternalAnalystAuthPreHandler(app);
    app.get('/probe', handler);

    const res = await app.inject({ method: 'GET', url: '/probe' });

    expect(res.statusCode).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    await app.close();
  });
});
