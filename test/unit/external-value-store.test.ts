import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from '../../src/db/pool.js';
import {
  persistExternalPublication,
  persistExternalValue,
  pinExternalValueForAudit,
} from '../../src/modules/reference-data/external-value-store.js';

describe('external publication and audit pin persistence', () => {
  it('inserts a publication version and returns its immutable id', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'publication-1' }] });
    await expect(persistExternalPublication({ query } as unknown as PoolClient, {
      sourceId: 'source-1', publicationVersion: '2026-08-25-r1', publishedAt: '2026-08-25T14:00:00Z',
      contentHash: 'a'.repeat(64),
    })).resolves.toBe('publication-1');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT'), [
      'source-1', '2026-08-25-r1', '2026-08-25T14:00:00Z', 'a'.repeat(64), null,
    ]);
  });

  it('resolves an idempotent publication retry without mutation', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'publication-1' }] });
    await expect(persistExternalPublication({ query } as unknown as PoolClient, {
      sourceId: 'source-1', publicationVersion: 'v1', publishedAt: '2026-08-25T00:00:00Z',
    })).resolves.toBe('publication-1');
  });

  it('canonicalizes decimal values and axis keys when inserting publication values', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'value-1', value: '3.125000' }] });
    await expect(persistExternalValue({ query } as unknown as PoolClient, {
      sourceId: 'source-1', publicationId: 'publication-1', axisKey: { week: '2026-08-24', region: 'PADD1' },
      publishedFor: '2026-08-24', value: '3.125',
    })).resolves.toEqual({ id: 'value-1', value: '3.125000' });
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      'source-1', 'publication-1', '{"region":"PADD1","week":"2026-08-24"}', '2026-08-24', '3.125000',
    ]);
  });

  it('fails closed when an idempotency key resolves to a different value', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'value-1', value: '4.000000' }] });
    await expect(persistExternalValue({ query } as unknown as PoolClient, {
      sourceId: 'source-1', publicationId: 'publication-1', axisKey: {}, publishedFor: '2026-08-24', value: '3',
    })).rejects.toThrow('external publication value conflict');
  });

  it('writes an audit-time snapshot pin idempotently', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'pin-1' }] });
    await expect(pinExternalValueForAudit({ query } as unknown as PoolClient, {
      clientId: 'client-1', auditRunId: 'run-1', resolverVersion: 'eia-v1', publicationId: 'publication-1',
      value: '3.125', pin: {
        externalValueId: 'value-1', sourceId: 'source-1', sourceCode: 'EIA_DIESEL', axisKey: { region: 'PADD1' },
        publishedFor: '2026-08-24', recordedAt: '2026-08-25T00:00:00Z',
      },
    })).resolves.toBe('pin-1');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('audit_external_value_pin'), [
      'client-1', 'run-1', 'value-1', 'publication-1', 'eia-v1', '{"region":"PADD1"}', '2026-08-24', '3.125000',
    ]);
  });
});
