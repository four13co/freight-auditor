import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * Unit coverage of pool.ts's pure logic (env var validation, lazy singleton
 * memoization, idempotent teardown) via a mocked `pg.Pool` constructor -- no
 * live DB. This module became reachable from the default suite once app.ts
 * started importing db/tenant-context.ts (which imports this) for the new
 * /api/findings route; the actual pooled-connection behavior stays covered
 * by the test/db/** suite against real Postgres.
 */
describe('pool.ts', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('throws when DATABASE_URL is not set', async () => {
    vi.stubEnv('DATABASE_URL', '');
    vi.doMock('pg', () => ({ default: { Pool: vi.fn() } }));
    const { getPool } = await import('../../src/db/pool.js');
    expect(() => getPool()).toThrow('DATABASE_URL is not set');
  });

  it('constructs the pool once from DATABASE_URL and memoises it on repeat calls', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://u:p@127.0.0.1:5432/d');
    const PoolCtor = vi.fn(function PoolStub(this: { end: () => void }) {
      this.end = vi.fn();
    });
    vi.doMock('pg', () => ({ default: { Pool: PoolCtor } }));
    const { getPool } = await import('../../src/db/pool.js');

    const first = getPool();
    const second = getPool();

    expect(PoolCtor).toHaveBeenCalledTimes(1);
    expect(PoolCtor).toHaveBeenCalledWith({ connectionString: 'postgresql://u:p@127.0.0.1:5432/d', max: 10 });
    expect(second).toBe(first);
  });

  it('closePool ends the pool and clears the memoised instance so a later getPool reconstructs it', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://u:p@127.0.0.1:5432/d');
    const end = vi.fn().mockResolvedValue(undefined);
    const PoolCtor = vi.fn(function PoolStub(this: { end: typeof end }) {
      this.end = end;
    });
    vi.doMock('pg', () => ({ default: { Pool: PoolCtor } }));
    const { getPool, closePool } = await import('../../src/db/pool.js');

    getPool();
    await closePool();

    expect(end).toHaveBeenCalledTimes(1);
    getPool();
    expect(PoolCtor).toHaveBeenCalledTimes(2);
  });

  it('closePool is a no-op when no pool has been constructed yet', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://u:p@127.0.0.1:5432/d');
    vi.doMock('pg', () => ({ default: { Pool: vi.fn() } }));
    const { closePool } = await import('../../src/db/pool.js');
    await expect(closePool()).resolves.toBeUndefined();
  });

  // 86e2zfjym: getReplicaPool/closeReplicaPool mirror getPool/closePool's own
  // lazy-singleton + idempotent-teardown shape, but gated on a second env var
  // that is unset by default -- covering that "unset" path is AC1's own
  // "zero behavioral diff" claim at the pool-construction level.
  it('getReplicaPool returns undefined when DATABASE_READ_REPLICA_URL is not set', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://u:p@127.0.0.1:5432/d');
    vi.stubEnv('DATABASE_READ_REPLICA_URL', '');
    vi.doMock('pg', () => ({ default: { Pool: vi.fn() } }));
    const { getReplicaPool } = await import('../../src/db/pool.js');
    expect(getReplicaPool()).toBeUndefined();
  });

  it('constructs the replica pool once from DATABASE_READ_REPLICA_URL and memoises it on repeat calls, distinct from the primary', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://u:p@127.0.0.1:5432/primary');
    vi.stubEnv('DATABASE_READ_REPLICA_URL', 'postgresql://u:p@127.0.0.1:5433/replica');
    const PoolCtor = vi.fn(function PoolStub(this: { end: () => void }) {
      this.end = vi.fn();
    });
    vi.doMock('pg', () => ({ default: { Pool: PoolCtor } }));
    const { getPool, getReplicaPool } = await import('../../src/db/pool.js');

    const primary = getPool();
    const firstReplica = getReplicaPool();
    const secondReplica = getReplicaPool();

    expect(PoolCtor).toHaveBeenCalledTimes(2);
    expect(PoolCtor).toHaveBeenCalledWith({ connectionString: 'postgresql://u:p@127.0.0.1:5433/replica', max: 10 });
    expect(secondReplica).toBe(firstReplica);
    expect(secondReplica).not.toBe(primary);
  });

  it('closeReplicaPool ends the replica pool and clears the memoised instance without touching the primary', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://u:p@127.0.0.1:5432/primary');
    vi.stubEnv('DATABASE_READ_REPLICA_URL', 'postgresql://u:p@127.0.0.1:5433/replica');
    const primaryEnd = vi.fn().mockResolvedValue(undefined);
    const replicaEnd = vi.fn().mockResolvedValue(undefined);
    let calls = 0;
    const PoolCtor = vi.fn(function PoolStub(this: { end: () => void }) {
      calls += 1;
      this.end = calls === 1 ? primaryEnd : replicaEnd;
    });
    vi.doMock('pg', () => ({ default: { Pool: PoolCtor } }));
    const { getPool, getReplicaPool, closeReplicaPool } = await import('../../src/db/pool.js');

    getPool();
    getReplicaPool();
    await closeReplicaPool();

    expect(replicaEnd).toHaveBeenCalledTimes(1);
    expect(primaryEnd).not.toHaveBeenCalled();
    getReplicaPool();
    expect(PoolCtor).toHaveBeenCalledTimes(3);
  });

  it('closeReplicaPool is a no-op when no replica pool has been constructed yet', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://u:p@127.0.0.1:5432/d');
    vi.stubEnv('DATABASE_READ_REPLICA_URL', '');
    vi.doMock('pg', () => ({ default: { Pool: vi.fn() } }));
    const { closeReplicaPool } = await import('../../src/db/pool.js');
    await expect(closeReplicaPool()).resolves.toBeUndefined();
  });
});
