import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from '../../src/db/pool.js';
import { MileageResolver, MILEAGE_RESOLVER_VERSION } from '../../src/modules/reference-data/mileage-resolver.js';

describe('mileage resolver adapter', () => {
  it('normalizes endpoints and returns pinned decimal miles', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      id: 'value-1', source_id: 'source-1', value: '812.4', published_for: '2026-08-01',
      recorded_at: '2026-08-01T12:00:00Z',
    }] });
    const result = await new MileageResolver().resolve({ query } as unknown as PoolClient, {
      sourceCode: 'PC_MILER', axisKey: { destination: ' memphis, tn ', origin: 'chicago, il', profile: 'practical' },
      publishedFor: '2026-08-01', recordedAsOf: '2026-08-25T00:00:00Z',
    });
    expect(result).toMatchObject({ status: 'FOUND', value: '812.400000', resolverVersion: MILEAGE_RESOLVER_VERSION });
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      'PC_MILER', '{"destination":"MEMPHIS, TN","origin":"CHICAGO, IL","profile":"practical"}',
      '2026-08-01', '2026-08-25T00:00:00Z',
    ]);
  });

  it('fails closed for incomplete lanes and unavailable snapshots', async () => {
    const query = vi.fn();
    const resolver = new MileageResolver();
    await expect(resolver.resolve({ query } as unknown as PoolClient, {
      sourceCode: 'PC_MILER', axisKey: { origin: 'ORD' }, publishedFor: '2026-08-01',
    })).resolves.toMatchObject({ status: 'UNAVAILABLE', reason: 'INVALID_REQUEST' });
    expect(query).not.toHaveBeenCalled();

    query.mockResolvedValue({ rows: [] });
    await expect(resolver.resolve({ query } as unknown as PoolClient, {
      sourceCode: 'PC_MILER', axisKey: { origin: 'ORD', destination: 'MEM' }, publishedFor: '2026-08-01',
    })).resolves.toEqual({ status: 'UNAVAILABLE', reason: 'VALUE_NOT_PUBLISHED', resolverVersion: MILEAGE_RESOLVER_VERSION });
  });
});
