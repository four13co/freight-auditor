import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { setTenantTxScope } from '../../src/db/tenant-context.js';

/**
 * Sets up a mocked pool.js for a single withTenantReadTx/withTenantTx test:
 * a distinct pg.Pool-shaped mock per pool so a test can assert which one was
 * actually connected to (86e2zfjym AC2).
 */
function mockPools(primaryClient: pg.PoolClient, replicaPool: { connect: ReturnType<typeof vi.fn> } | undefined) {
  const primaryConnect = vi.fn().mockResolvedValue(primaryClient);
  vi.doMock('../../src/db/pool.js', () => ({
    getPool: () => ({ connect: primaryConnect }),
    getReplicaPool: () => replicaPool,
    APP_ROLE: 'freight_app',
  }));
  return { primaryConnect };
}

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

// 86e2zfjym: withTenantReadTx AC coverage.
describe('withTenantReadTx', () => {
  it('falls back to the primary pool when no replica pool is configured (AC1: identical to withTenantTx today)', async () => {
    const release = vi.fn();
    const client = { ...mockClient(), release } as unknown as pg.PoolClient;
    const { primaryConnect } = mockPools(client, undefined);
    vi.resetModules();
    const { withTenantReadTx: withTenantReadTxMocked } = await import('../../src/db/tenant-context.js');

    const fn = vi.fn().mockResolvedValue('result');
    const result = await withTenantReadTxMocked({ clientIds: ['a'], internal: false }, fn);

    expect(result).toBe('result');
    expect(primaryConnect).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(client);
    vi.doUnmock('../../src/db/pool.js');
  });

  it('checks out a connection from the replica pool, not the primary, when DATABASE_READ_REPLICA_URL is configured (AC2)', async () => {
    const primaryClient = { ...mockClient(), release: vi.fn() } as unknown as pg.PoolClient;
    const replicaClient = { ...mockClient(), release: vi.fn() } as unknown as pg.PoolClient;
    const replicaConnect = vi.fn().mockResolvedValue(replicaClient);
    const { primaryConnect } = mockPools(primaryClient, { connect: replicaConnect });
    vi.resetModules();
    const { withTenantReadTx: withTenantReadTxMocked } = await import('../../src/db/tenant-context.js');

    const fn = vi.fn().mockResolvedValue('result');
    await withTenantReadTxMocked({}, fn);

    expect(replicaConnect).toHaveBeenCalledTimes(1);
    expect(primaryConnect).not.toHaveBeenCalled();
    expect(fn).toHaveBeenCalledWith(replicaClient);
    vi.doUnmock('../../src/db/pool.js');
  });

  it('applies the same tenant-scope GUC + SET LOCAL ROLE sequence, in order, on the replica connection (AC3 unit half)', async () => {
    const primaryClient = { ...mockClient(), release: vi.fn() } as unknown as pg.PoolClient;
    const replicaClient = { ...mockClient(), release: vi.fn() } as unknown as pg.PoolClient;
    const replicaConnect = vi.fn().mockResolvedValue(replicaClient);
    mockPools(primaryClient, { connect: replicaConnect });
    vi.resetModules();
    const { withTenantReadTx: withTenantReadTxMocked } = await import('../../src/db/tenant-context.js');

    await withTenantReadTxMocked({ clientIds: ['a', 'b'], internal: true }, vi.fn().mockResolvedValue(undefined));

    const calls = (replicaClient.query as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]).toEqual(['BEGIN']);
    expect(calls[1]).toEqual(['SELECT set_config($1, $2, true)', ['app.current_client_ids', 'a,b']]);
    expect(calls[2]).toEqual(['SELECT set_config($1, $2, true)', ['app.is_internal', 'true']]);
    expect(calls[3]).toEqual(['SET LOCAL ROLE freight_app']);
    vi.doUnmock('../../src/db/pool.js');
  });

  it('rolls back and releases (never commits) the replica connection when the callback throws', async () => {
    const primaryClient = { ...mockClient(), release: vi.fn() } as unknown as pg.PoolClient;
    const release = vi.fn();
    const replicaClient = { ...mockClient(), release } as unknown as pg.PoolClient;
    const replicaConnect = vi.fn().mockResolvedValue(replicaClient);
    mockPools(primaryClient, { connect: replicaConnect });
    vi.resetModules();
    const { withTenantReadTx: withTenantReadTxMocked } = await import('../../src/db/tenant-context.js');

    const boom = new Error('boom');
    await expect(withTenantReadTxMocked({}, vi.fn().mockRejectedValue(boom))).rejects.toThrow('boom');
    const queryCalls = (replicaClient.query as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(queryCalls).toContain('ROLLBACK');
    expect(queryCalls).not.toContain('COMMIT');
    expect(release).toHaveBeenCalledTimes(1);
    vi.doUnmock('../../src/db/pool.js');
  });
});
