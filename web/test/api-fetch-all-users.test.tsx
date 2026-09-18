import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAllUsers } from '@/lib/api';

/**
 * 86e3a7d57: fetchAllUsers() used to fan out client-side (GET
 * /api/internal/tenants, capped at limit=100, then GET
 * /api/internal/tenants/:id/members per tenant) -- silently dropping any
 * tenant past the 100th. It now pages the cross-tenant GET
 * /api/internal/members endpoint via its keyset cursor until exhausted.
 * These tests prove the paging loop itself (the >100-tenant/page-boundary
 * case is proven at the browser level by
 * web/test/e2e-fullstack/admin-users-cross-tenant.fullstack.spec.ts, since
 * that's the layer the AC calls for -- see this task's Done-when).
 */
describe('fetchAllUsers', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('pages through every cursor page and aggregates all rows', async () => {
    const page1 = {
      members: [
        { id: 'm1', userId: 'u1', email: 'a@x.test', fullName: 'A', role: 'analyst', isActive: true, accountId: 't1', accountName: 'T1', createdAt: '2026-01-01T00:00:00Z' },
      ],
      nextCursor: 'cursor-1',
    };
    const page2 = {
      members: [
        { id: 'm2', userId: 'u2', email: 'b@x.test', fullName: 'B', role: 'lead', isActive: false, accountId: 't2', accountName: 'T2', createdAt: '2026-01-02T00:00:00Z' },
      ],
      nextCursor: null,
    };
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => page1 })
      .mockResolvedValueOnce({ ok: true, json: async () => page2 });

    const rows = await fetchAllUsers();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/internal/members');
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/internal/members?cursor=cursor-1');
    expect(rows).toEqual([
      { membershipId: 'm1', userId: 'u1', email: 'a@x.test', fullName: 'A', role: 'analyst', isActive: true, tenantId: 't1', tenantName: 'T1', createdAt: '2026-01-01T00:00:00Z' },
      { membershipId: 'm2', userId: 'u2', email: 'b@x.test', fullName: 'B', role: 'lead', isActive: false, tenantId: 't2', tenantName: 'T2', createdAt: '2026-01-02T00:00:00Z' },
    ]);

    // Never calls the old tenants/members fan-out endpoints.
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).not.toMatch(/\/api\/internal\/tenants/);
    }
  });

  it('stops on a single page when nextCursor is null', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ members: [], nextCursor: null }),
    });

    const rows = await fetchAllUsers();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([]);
  });

  it('stops and returns what it has so far if a page request fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) });

    const rows = await fetchAllUsers();

    expect(rows).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
