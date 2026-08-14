import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { setTenantTxScope } from '../../src/db/tenant-context.js';

/**
 * Unit coverage of tenant-context.ts's transaction orchestration via a
 * mocked pg.PoolClient/Pool -- no live DB. Reachable from the default suite
 * via app.ts's import for /api/findings. RLS-bound tenant isolation itself
 * (the point of this module) stays covered against real Postgres by
 * test/db/**'s withTenantTx-based tests.
 */
function mockClient() {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  return { query } as unknown as pg.PoolClient;
}

describe('setTenantTxScope', () => {
  it('sets the client-scope and internal GUCs, then drops into the app role, in order', async () => {
    const client = mockClient();
    await setTenantTxScope(client, { clientIds: ['a', 'b'], internal: true });
    const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]).toEqual(['SELECT set_config($1, $2, true)', ['app.current_client_ids', 'a,b']]);
    expect(calls[1]).toEqual(['SELECT set_config($1, $2, true)', ['app.is_internal', 'true']]);
    expect(calls[2]).toEqual(['SET LOCAL ROLE freight_app']);
  });

  it('defaults to an empty client scope and non-internal when the context omits both', async () => {
    const client = mockClient();
    await setTenantTxScope(client, {});
    const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]).toEqual(['SELECT set_config($1, $2, true)', ['app.current_client_ids', '']]);
    expect(calls[1]).toEqual(['SELECT set_config($1, $2, true)', ['app.is_internal', 'false']]);
  });
});

describe('withTenantTx', () => {
  function mockPool(client: pg.PoolClient) {
    return { connect: vi.fn().mockResolvedValue(client) };
  }

  it('runs BEGIN, the scope GUCs, the callback, then COMMIT, and always releases the client', async () => {
    const release = vi.fn();
    const client = { ...mockClient(), release } as unknown as pg.PoolClient;
    vi.doMock('../../src/db/pool.js', () => ({ getPool: () => mockPool(client), APP_ROLE: 'freight_app' }));
    vi.resetModules();
    const { withTenantTx: withTenantTxMocked } = await import('../../src/db/tenant-context.js');

    const fn = vi.fn().mockResolvedValue('result');
    const result = await withTenantTxMocked({ clientIds: ['a'], internal: false }, fn);

    expect(result).toBe('result');
    expect(fn).toHaveBeenCalledWith(client);
    const queryCalls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(queryCalls[0]).toBe('BEGIN');
    expect(queryCalls.at(-1)).toBe('COMMIT');
    expect(release).toHaveBeenCalledTimes(1);
    vi.doUnmock('../../src/db/pool.js');
  });

  it('rolls back and releases (never commits) when the callback throws, and rethrows the original error', async () => {
    const release = vi.fn();
    const client = { ...mockClient(), release } as unknown as pg.PoolClient;
    vi.doMock('../../src/db/pool.js', () => ({ getPool: () => mockPool(client), APP_ROLE: 'freight_app' }));
    vi.resetModules();
    const { withTenantTx: withTenantTxMocked } = await import('../../src/db/tenant-context.js');

    const boom = new Error('boom');
    const fn = vi.fn().mockRejectedValue(boom);

    await expect(withTenantTxMocked({}, fn)).rejects.toThrow('boom');
    const queryCalls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(queryCalls).toContain('ROLLBACK');
    expect(queryCalls).not.toContain('COMMIT');
    expect(release).toHaveBeenCalledTimes(1);
    vi.doUnmock('../../src/db/pool.js');
  });

  it('still releases the client even if the ROLLBACK itself fails', async () => {
    const release = vi.fn();
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql === 'ROLLBACK') return Promise.reject(new Error('rollback failed'));
      return Promise.resolve({ rows: [] });
    });
    const client = { query, release } as unknown as pg.PoolClient;
    vi.doMock('../../src/db/pool.js', () => ({ getPool: () => mockPool(client), APP_ROLE: 'freight_app' }));
    vi.resetModules();
    const { withTenantTx: withTenantTxMocked } = await import('../../src/db/tenant-context.js');

    const original = new Error('original failure');
    await expect(withTenantTxMocked({}, vi.fn().mockRejectedValue(original))).rejects.toThrow(
      'original failure',
    );
    expect(release).toHaveBeenCalledTimes(1);
    vi.doUnmock('../../src/db/pool.js');
  });
});
