import { describe, it, expect, vi, afterEach } from 'vitest';
import type { FastifyRequest } from 'fastify';

/**
 * Unit coverage of resolveAuthorizedTenantContext's header-gating logic via a
 * mocked withTenantTx -- no live DB. The real membership-row check (the point
 * of this module) stays covered against real Postgres by
 * test/db/tenant-auth.db.test.ts.
 */
function mockRequest(headers: Record<string, string | string[] | undefined>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

describe('resolveAuthorizedTenantContext', () => {
  afterEach(() => {
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
