import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyRequest } from 'fastify';

/**
 * Unit coverage of resolveAuthorizedTenantContext's header-gating logic via a
 * mocked withTenantTx -- no live DB. The real membership-row check (the point
 * of this module) stays covered against real Postgres by
 * test/db/tenant-auth.db.test.ts.
 *
 * 86e2v1bbr gated this path behind DEV_AUTH_HEADERS (unset = a verified
 * better-auth session is required instead -- see the "DEV_AUTH_HEADERS unset"
 * describe block below). This suite sets the flag so it keeps proving exactly
 * what it always proved: the dev-header path, unchanged, when the flag is on.
 */
function mockRequest(headers: Record<string, string | string[] | undefined>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

describe('resolveAuthorizedTenantContext (DEV_AUTH_HEADERS set)', () => {
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

  it('returns null when x-client-id is missing, without querying the DB', async () => {
    const withTenantTx = vi.fn();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveAuthorizedTenantContext } = await import('../../src/modules/findings/tenant-auth.js');

    const ctx = await resolveAuthorizedTenantContext(mockRequest({ 'x-user-id': 'user-1' }));
    expect(ctx).toBeNull();
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('returns null when x-user-id is missing, without querying the DB', async () => {
    const withTenantTx = vi.fn();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveAuthorizedTenantContext } = await import('../../src/modules/findings/tenant-auth.js');

    const ctx = await resolveAuthorizedTenantContext(mockRequest({ 'x-client-id': 'client-1' }));
    expect(ctx).toBeNull();
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('returns null when both headers are absent', async () => {
    const withTenantTx = vi.fn();
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveAuthorizedTenantContext } = await import('../../src/modules/findings/tenant-auth.js');

    const ctx = await resolveAuthorizedTenantContext(mockRequest({}));
    expect(ctx).toBeNull();
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('looks up membership under an internal-scoped transaction and returns the client scope when found', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const withTenantTx = vi.fn(async (ctx, fn) => fn({ query }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveAuthorizedTenantContext } = await import('../../src/modules/findings/tenant-auth.js');

    const ctx = await resolveAuthorizedTenantContext(
      mockRequest({ 'x-client-id': 'client-1', 'x-user-id': 'user-1' }),
    );

    expect(withTenantTx).toHaveBeenCalledWith({ internal: true }, expect.any(Function));
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM membership'), ['user-1', 'client-1']);
    expect(ctx).toEqual({ clientIds: ['client-1'], internal: false });
  });

  it('returns null when no membership row exists for the claimed pair', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0 });
    const withTenantTx = vi.fn(async (ctx, fn) => fn({ query }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveAuthorizedTenantContext } = await import('../../src/modules/findings/tenant-auth.js');

    const ctx = await resolveAuthorizedTenantContext(
      mockRequest({ 'x-client-id': 'client-1', 'x-user-id': 'user-1' }),
    );
    expect(ctx).toBeNull();
  });

  it('takes the first value when a header is sent multiple times', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const withTenantTx = vi.fn(async (ctx, fn) => fn({ query }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveAuthorizedTenantContext } = await import('../../src/modules/findings/tenant-auth.js');

    await resolveAuthorizedTenantContext(
      mockRequest({ 'x-client-id': ['client-a', 'client-b'], 'x-user-id': ['user-a', 'user-b'] }),
    );
    expect(query).toHaveBeenCalledWith(expect.any(String), ['user-a', 'client-a']);
  });
});

/**
 * 86e2v1bbr AC2 -- "the AC that matters most": a header-based bypass must
 * not survive into an environment where DEV_AUTH_HEADERS wasn't explicitly
 * set. Unit-level (mocked getAuth/withTenantTx, no live DB) -- the real
 * verified-session round-trip is covered against real Postgres by
 * test/db/tenant-auth-session.db.test.ts.
 */
describe('resolveAuthorizedTenantContext (DEV_AUTH_HEADERS unset -- the prod default)', () => {
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

  it('rejects the dev x-client-id/x-user-id headers alone, without a session cookie (the header bypass this AC closes) -- never touches auth or the DB', async () => {
    const getSession = vi.fn();
    const withTenantTx = vi.fn();
    vi.doMock('../../src/auth/better-auth.js', () => ({ getAuth: () => ({ api: { getSession } }) }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveAuthorizedTenantContext } = await import('../../src/modules/findings/tenant-auth.js');

    const ctx = await resolveAuthorizedTenantContext(
      mockRequest({ 'x-client-id': 'client-1', 'x-user-id': 'user-1' }),
    );
    expect(ctx).toBeNull();
    expect(getSession).not.toHaveBeenCalled();
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('rejects a request with no cookie and no dev headers at all, without touching auth or the DB', async () => {
    const getSession = vi.fn();
    const withTenantTx = vi.fn();
    vi.doMock('../../src/auth/better-auth.js', () => ({ getAuth: () => ({ api: { getSession } }) }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveAuthorizedTenantContext } = await import('../../src/modules/findings/tenant-auth.js');

    const ctx = await resolveAuthorizedTenantContext(mockRequest({}));
    expect(ctx).toBeNull();
    expect(getSession).not.toHaveBeenCalled();
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('rejects a cookie that resolves to no valid session', async () => {
    const getSession = vi.fn().mockResolvedValue(null);
    const withTenantTx = vi.fn();
    vi.doMock('../../src/auth/better-auth.js', () => ({ getAuth: () => ({ api: { getSession } }) }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveAuthorizedTenantContext } = await import('../../src/modules/findings/tenant-auth.js');

    const ctx = await resolveAuthorizedTenantContext(mockRequest({ cookie: 'better-auth.session_token=stale' }));
    expect(ctx).toBeNull();
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('resolves via a verified session + membership row when both are present', async () => {
    const getSession = vi.fn().mockResolvedValue({ user: { id: 'session-user-1' }, session: {} });
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const withTenantTx = vi.fn(async (ctx, fn) => fn({ query }));
    vi.doMock('../../src/auth/better-auth.js', () => ({ getAuth: () => ({ api: { getSession } }) }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveAuthorizedTenantContext } = await import('../../src/modules/findings/tenant-auth.js');

    const ctx = await resolveAuthorizedTenantContext(
      mockRequest({ cookie: 'better-auth.session_token=valid', 'x-client-id': 'client-1' }),
    );

    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM membership'), ['session-user-1', 'client-1']);
    expect(ctx).toEqual({ clientIds: ['client-1'], internal: false });
  });

  it('rejects a valid session with no membership row for the target client', async () => {
    const getSession = vi.fn().mockResolvedValue({ user: { id: 'session-user-1' }, session: {} });
    const query = vi.fn().mockResolvedValue({ rowCount: 0 });
    const withTenantTx = vi.fn(async (ctx, fn) => fn({ query }));
    vi.doMock('../../src/auth/better-auth.js', () => ({ getAuth: () => ({ api: { getSession } }) }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveAuthorizedTenantContext } = await import('../../src/modules/findings/tenant-auth.js');

    const ctx = await resolveAuthorizedTenantContext(
      mockRequest({ cookie: 'better-auth.session_token=valid', 'x-client-id': 'client-1' }),
    );
    expect(ctx).toBeNull();
  });

  it('rejects a valid session when x-client-id is absent', async () => {
    const getSession = vi.fn().mockResolvedValue({ user: { id: 'session-user-1' }, session: {} });
    const withTenantTx = vi.fn();
    vi.doMock('../../src/auth/better-auth.js', () => ({ getAuth: () => ({ api: { getSession } }) }));
    vi.doMock('../../src/db/tenant-context.js', () => ({ withTenantTx }));
    const { resolveAuthorizedTenantContext } = await import('../../src/modules/findings/tenant-auth.js');

    const ctx = await resolveAuthorizedTenantContext(mockRequest({ cookie: 'better-auth.session_token=valid' }));
    expect(ctx).toBeNull();
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('propagates (does not swallow) a genuine backend error when a cookie IS present -- a DB/session outage is a 500, not a silent 401', async () => {
    const getSession = vi.fn().mockRejectedValue(new Error('DATABASE_URL is not set'));
    vi.doMock('../../src/auth/better-auth.js', () => ({ getAuth: () => ({ api: { getSession } }) }));
    const { resolveAuthorizedTenantContext } = await import('../../src/modules/findings/tenant-auth.js');

    await expect(
      resolveAuthorizedTenantContext(mockRequest({ cookie: 'better-auth.session_token=valid' })),
    ).rejects.toThrow('DATABASE_URL is not set');
  });
});
