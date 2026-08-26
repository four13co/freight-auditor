import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from '../../src/db/pool.js';
import { ExternalResolverRegistry } from '../../src/modules/reference-data/external-value-resolver.js';
import {
  OceanIndexResolver, OCEAN_INDEX_RESOLVER_VERSION, oceanIndexResolvers,
} from '../../src/modules/reference-data/ocean-index-resolver.js';

describe('ocean tariff/index resolver adapters', () => {
  it('registers independent BAF, GRI, and PSS sources', () => {
    expect(oceanIndexResolvers().map((resolver) => resolver.sourceCode)).toEqual(['OCEAN_BAF', 'OCEAN_GRI', 'OCEAN_PSS']);
    expect(() => new ExternalResolverRegistry(oceanIndexResolvers())).not.toThrow();
  });

  it.each(['OCEAN_BAF', 'OCEAN_GRI', 'OCEAN_PSS'] as const)('resolves pinned %s values by normalized lane/currency', async (sourceCode) => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      id: `${sourceCode}-value`, source_id: `${sourceCode}-source`, value: '425',
      published_for: '2026-08-01', recorded_at: '2026-07-20T00:00:00Z',
    }] });
    const result = await new OceanIndexResolver(sourceCode).resolve({ query } as unknown as PoolClient, {
      sourceCode, axisKey: { trade_lane: ' asia-uswc ', currency: 'usd', equipment: '40HC' },
      publishedFor: '2026-08-01',
    });
    expect(result).toMatchObject({ status: 'FOUND', value: '425.000000', resolverVersion: OCEAN_INDEX_RESOLVER_VERSION });
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      sourceCode, '{"currency":"USD","equipment":"40HC","trade_lane":"ASIA-USWC"}', '2026-08-01',
    ]);
  });

  it('returns explicit invalid and unpublished outcomes', async () => {
    const query = vi.fn();
    const resolver = new OceanIndexResolver('OCEAN_BAF');
    await expect(resolver.resolve({ query } as unknown as PoolClient, {
      sourceCode: 'OCEAN_BAF', axisKey: { trade_lane: 'ASIA-USWC', currency: 'dollars' }, publishedFor: '2026-08-01',
    })).resolves.toMatchObject({ status: 'UNAVAILABLE', reason: 'INVALID_REQUEST' });
    expect(query).not.toHaveBeenCalled();
    query.mockResolvedValue({ rows: [] });
    await expect(resolver.resolve({ query } as unknown as PoolClient, {
      sourceCode: 'OCEAN_BAF', axisKey: { trade_lane: 'ASIA-USWC', currency: 'USD' }, publishedFor: '2026-08-01',
    })).resolves.toEqual({ status: 'UNAVAILABLE', reason: 'VALUE_NOT_PUBLISHED', resolverVersion: OCEAN_INDEX_RESOLVER_VERSION });
  });
});
