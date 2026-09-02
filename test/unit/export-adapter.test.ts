import { describe, expect, it } from 'vitest';
import type { PoolClient } from '../../src/db/pool.js';
import {
  DuplicateExportAdapterError,
  ExportAdapterRegistry,
} from '../../src/modules/exports/export-adapter.js';
import { StandInExportAdapter } from '../../src/modules/exports/stand-in-export-adapter.js';

const client = {} as PoolClient;

describe('AP/ERP export adapter interface, registry, and stand-in', () => {
  it('returns a deterministic ACKNOWLEDGED result with no real external call for a registered system', async () => {
    const adapter = new StandInExportAdapter('QUICKBOOKS');
    const registry = new ExportAdapterRegistry([adapter]);

    const result = await registry.export(client, {
      systemCode: 'quickbooks',
      dedupeKey: 'invoice-1',
      payload: {},
    });

    expect(result).toEqual({
      status: 'ACKNOWLEDGED',
      externalReference: 'standin-QUICKBOOKS-invoice-1',
      adapterVersion: 'stand-in-v1',
    });
  });

  it('returns a deterministic FAILED result when the stand-in is asked to simulate a failure', async () => {
    const adapter = new StandInExportAdapter('QUICKBOOKS');
    const registry = new ExportAdapterRegistry([adapter]);

    const result = await registry.export(client, {
      systemCode: 'QUICKBOOKS',
      dedupeKey: 'invoice-2',
      payload: { simulateFailure: true },
    });

    expect(result).toEqual({
      status: 'FAILED',
      reason: 'SIMULATED_FAILURE',
      adapterVersion: 'stand-in-v1',
    });
  });

  it('returns a structured not-configured result rather than throwing for an unregistered system code', async () => {
    const registry = new ExportAdapterRegistry([new StandInExportAdapter('QUICKBOOKS')]);

    await expect(registry.export(client, {
      systemCode: 'NETSUITE',
      dedupeKey: 'invoice-3',
      payload: {},
    })).resolves.toEqual({ status: 'NOT_CONFIGURED', systemCode: 'NETSUITE' });
  });

  it('does not produce a second distinct external effect for a repeated dedupeKey', async () => {
    const adapter = new StandInExportAdapter('QUICKBOOKS');
    const registry = new ExportAdapterRegistry([adapter]);
    const record = { systemCode: 'QUICKBOOKS', dedupeKey: 'invoice-4', payload: {} };

    const first = await registry.export(client, record);
    const second = await registry.export(client, record);

    expect(second).toEqual(first);
    expect(adapter.effectCount).toBe(1);
  });

  it('rejects duplicate normalized system-code registrations', () => {
    expect(() => new ExportAdapterRegistry([
      new StandInExportAdapter('QUICKBOOKS'),
      new StandInExportAdapter(' quickbooks '),
    ])).toThrow(DuplicateExportAdapterError);
  });
});
