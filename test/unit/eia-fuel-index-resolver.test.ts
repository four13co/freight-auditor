import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from '../../src/db/pool.js';
import { ExternalResolverRegistry } from '../../src/modules/reference-data/external-value-resolver.js';
import {
  EiaFuelIndexResolver,
  EIA_FUEL_RESOLVER_VERSION,
} from '../../src/modules/reference-data/eia-fuel-index-resolver.js';

describe('EIA fuel-index resolver', () => {
  it('resolves a six-decimal weekly value with immutable pin metadata', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      id: 'value-1', source_id: 'source-1', value: '3.125', published_for: '2026-08-24',
      recorded_at: new Date('2026-08-25T14:00:00Z'),
    }] });
    const registry = new ExternalResolverRegistry([new EiaFuelIndexResolver()]);
    const result = await registry.resolve({ query } as unknown as PoolClient, {
      sourceCode: 'EIA_DIESEL', axisKey: { week_of: '2026-08-24', region: 'PADD1' },
      publishedFor: '2026-08-24', recordedAsOf: '2026-08-26T00:00:00Z',
    });
    expect(result).toEqual({
      status: 'FOUND', value: '3.125000', resolverVersion: EIA_FUEL_RESOLVER_VERSION,
      pin: {
        externalValueId: 'value-1', sourceId: 'source-1', sourceCode: 'EIA_DIESEL',
        axisKey: { region: 'PADD1', week_of: '2026-08-24' }, publishedFor: '2026-08-24',
        recordedAt: '2026-08-25T14:00:00.000Z',
      },
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ev.recorded_at <= $4'), [
      'EIA_DIESEL', '{"region":"PADD1","week_of":"2026-08-24"}', '2026-08-24', '2026-08-26T00:00:00Z',
    ]);
  });

  it('returns unavailable instead of guessing when no weekly value was published', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(new EiaFuelIndexResolver().resolve({ query } as unknown as PoolClient, {
      sourceCode: 'EIA_DIESEL', axisKey: { region: 'PADD2' }, publishedFor: '2026-08-24',
    })).resolves.toEqual({
      status: 'UNAVAILABLE', reason: 'VALUE_NOT_PUBLISHED', resolverVersion: EIA_FUEL_RESOLVER_VERSION,
    });
  });

  it('rejects missing region and wrong-source requests before database access', async () => {
    const query = vi.fn();
    const resolver = new EiaFuelIndexResolver();
    await expect(resolver.resolve({ query } as unknown as PoolClient, {
      sourceCode: 'EIA_DIESEL', axisKey: {}, publishedFor: '2026-08-24',
    })).resolves.toMatchObject({ status: 'UNAVAILABLE', reason: 'INVALID_REQUEST' });
    await expect(resolver.resolve({ query } as unknown as PoolClient, {
      sourceCode: 'OTHER', axisKey: { region: 'PADD1' }, publishedFor: '2026-08-24',
    })).resolves.toMatchObject({ status: 'UNAVAILABLE', reason: 'INVALID_REQUEST' });
    expect(query).not.toHaveBeenCalled();
  });
});
