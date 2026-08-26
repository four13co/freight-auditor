import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from '../../src/db/pool.js';
import {
  DuplicateExternalResolverError,
  ExternalResolverRegistry,
  canonicalAxisKey,
  type ExternalValueResolver,
} from '../../src/modules/reference-data/external-value-resolver.js';

const client = {} as PoolClient;

function resolver(sourceCode = 'EIA_DIESEL'): ExternalValueResolver {
  return {
    sourceCode,
    resolverVersion: 'eia-v1',
    resolve: vi.fn(async (_client, request) => ({
      status: 'FOUND' as const,
      value: '3.125000',
      resolverVersion: 'eia-v1',
      pin: {
        externalValueId: 'value-1', sourceId: 'source-1', sourceCode: request.sourceCode,
        axisKey: request.axisKey, publishedFor: request.publishedFor, recordedAt: '2026-08-25T00:00:00.000Z',
      },
    })),
  };
}

describe('versioned external-value resolver interfaces', () => {
  it('normalizes routing and canonicalizes axis keys before resolution', async () => {
    const adapter = resolver();
    const registry = new ExternalResolverRegistry([adapter]);
    const result = await registry.resolve(client, {
      sourceCode: ' eia_diesel ', axisKey: { week_of: '2026-08-24', region: 'PADD1' }, publishedFor: '2026-08-24',
    });
    expect(result).toMatchObject({ status: 'FOUND', resolverVersion: 'eia-v1' });
    expect(adapter.resolve).toHaveBeenCalledWith(client, expect.objectContaining({
      sourceCode: 'EIA_DIESEL', axisKey: { region: 'PADD1', week_of: '2026-08-24' },
    }));
  });

  it('returns explicit unavailable outcomes for unknown sources and invalid temporal keys', async () => {
    const registry = new ExternalResolverRegistry([resolver()]);
    await expect(registry.resolve(client, {
      sourceCode: 'NMFC', axisKey: {}, publishedFor: '2026-08-24',
    })).resolves.toEqual({ status: 'UNAVAILABLE', reason: 'SOURCE_NOT_CONFIGURED', resolverVersion: 'registry-v1' });
    await expect(registry.resolve(client, {
      sourceCode: 'EIA_DIESEL', axisKey: {}, publishedFor: 'not-a-date',
    })).resolves.toEqual({ status: 'UNAVAILABLE', reason: 'INVALID_REQUEST', resolverVersion: 'eia-v1' });
  });

  it('rejects duplicate normalized source registrations', () => {
    expect(() => new ExternalResolverRegistry([resolver(), resolver(' eia_diesel ')])).toThrow(DuplicateExternalResolverError);
  });

  it('canonicalizes equivalent axis keys byte-stably', () => {
    expect(JSON.stringify(canonicalAxisKey({ z: 1, a: 'x' }))).toBe(JSON.stringify(canonicalAxisKey({ a: 'x', z: 1 })));
  });
});
