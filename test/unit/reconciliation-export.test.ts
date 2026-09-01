import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import {
  requestReconciliationExport,
  getReconciliationExport,
  claimDueReconciliationExports,
  completeReconciliationExport,
  failReconciliationExport,
} from '../../src/modules/claims/reconciliation-export.js';

const CLIENT_ID = '30000000-0000-4000-8000-000000000001';
const EXPORT_ID = '30000000-0000-4000-8000-000000000004';
const NOW = new Date('2026-09-01T00:00:00.000Z');

interface MockOpts {
  insertedId?: string | null;
  existingId?: string | null;
}

function mockClient(opts: MockOpts = {}) {
  const { insertedId = EXPORT_ID, existingId = null } = opts;
  const query = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('INSERT INTO reconciliation_export')) {
      return Promise.resolve({ rows: insertedId ? [{ id: insertedId }] : [], rowCount: insertedId ? 1 : 0 });
    }
    if (sql.includes('SELECT id FROM reconciliation_export')) {
      return Promise.resolve({ rows: existingId ? [{ id: existingId }] : [], rowCount: existingId ? 1 : 0 });
    }
    if (sql.includes('UPDATE reconciliation_export')) {
      return Promise.resolve({ rowCount: 1 });
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  return { client: { query } as unknown as pg.PoolClient, query };
}

function findCall(query: ReturnType<typeof vi.fn>, needle: string): [string, unknown[]] {
  const call = query.mock.calls.find((call: unknown[]) => (call[0] as string).includes(needle));
  if (!call) throw new Error(`no call matching ${needle}`);
  return call as [string, unknown[]];
}

describe('requestReconciliationExport', () => {
  it('inserts a new export request and returns created: true', async () => {
    const { client, query } = mockClient();
    const result = await requestReconciliationExport(client, { clientId: CLIENT_ID, idempotencyKey: 'daily-2026-09-01' });
    expect(result).toEqual({ exportId: EXPORT_ID, created: true });

    const [, values] = findCall(query, 'INSERT INTO reconciliation_export');
    expect(values).toEqual([CLIENT_ID, 'daily-2026-09-01']);
  });

  it('is idempotent: a conflicting idempotencyKey returns the existing row instead of a duplicate', async () => {
    const { client } = mockClient({ insertedId: null, existingId: 'existing-export-id' });
    const result = await requestReconciliationExport(client, { clientId: CLIENT_ID, idempotencyKey: 'daily-2026-09-01' });
    expect(result).toEqual({ exportId: 'existing-export-id', created: false });
  });

  it('rejects an empty idempotencyKey', async () => {
    const { client } = mockClient();
    await expect(requestReconciliationExport(client, { clientId: CLIENT_ID, idempotencyKey: '' })).rejects.toThrow();
  });
});

describe('getReconciliationExport', () => {
  it('returns null when the export is not found', async () => {
    const { client, query } = mockClient();
    query.mockImplementationOnce((sql: string) => {
      if (sql.includes('SELECT id, status')) return Promise.resolve({ rows: [] });
      throw new Error(`unexpected query: ${sql}`);
    });
    const result = await getReconciliationExport(client, { clientId: CLIENT_ID, exportId: EXPORT_ID });
    expect(result).toBeNull();
  });

  it('maps a completed row to camelCase, including its result', async () => {
    const { client, query } = mockClient();
    const bucket = { currency: 'USD', claimed: '100.0000', recovered: '100.0000', outstanding: '0.0000', writtenOff: '0.0000', denied: '0.0000', reconciles: true };
    query.mockImplementationOnce((sql: string) => {
      if (sql.includes('SELECT id, status')) {
        return Promise.resolve({
          rows: [{
            id: EXPORT_ID,
            status: 'completed',
            result: [bucket],
            error: null,
            requested_at: new Date('2026-09-01T00:00:00.000Z'),
            completed_at: new Date('2026-09-01T00:01:00.000Z'),
          }],
        });
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const result = await getReconciliationExport(client, { clientId: CLIENT_ID, exportId: EXPORT_ID });
    expect(result).toEqual({
      id: EXPORT_ID,
      status: 'completed',
      result: [bucket],
      error: null,
      requestedAt: '2026-09-01T00:00:00.000Z',
      completedAt: '2026-09-01T00:01:00.000Z',
    });
  });

  it('maps a pending row with null result/error/completedAt', async () => {
    const { client, query } = mockClient();
    query.mockImplementationOnce((sql: string) => {
      if (sql.includes('SELECT id, status')) {
        return Promise.resolve({
          rows: [{
            id: EXPORT_ID,
            status: 'pending',
            result: null,
            error: null,
            requested_at: new Date('2026-09-01T00:00:00.000Z'),
            completed_at: null,
          }],
        });
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const result = await getReconciliationExport(client, { clientId: CLIENT_ID, exportId: EXPORT_ID });
    expect(result).toMatchObject({ status: 'pending', result: null, error: null, completedAt: null });
  });
});

describe('claimDueReconciliationExports', () => {
  it('claims due pending exports and returns them mapped to camelCase', async () => {
    const { client, query } = mockClient();
    query.mockResolvedValueOnce({ rows: [{ id: EXPORT_ID, idempotency_key: 'daily-2026-09-01' }], rowCount: 1 });

    const result = await claimDueReconciliationExports(client, { clientId: CLIENT_ID, now: NOW });

    expect(result).toEqual([{ exportId: EXPORT_ID, idempotencyKey: 'daily-2026-09-01' }]);
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain("status = 'claimed'");
    expect(values).toEqual([CLIENT_ID, NOW.toISOString(), 50]);
  });

  it('returns an empty array when nothing is due', async () => {
    const { client, query } = mockClient();
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await claimDueReconciliationExports(client, { clientId: CLIENT_ID, now: NOW });
    expect(result).toEqual([]);
  });

  it('respects a caller-supplied limit', async () => {
    const { client, query } = mockClient();
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await claimDueReconciliationExports(client, { clientId: CLIENT_ID, now: NOW, limit: 5 });
    const [, values] = query.mock.calls[0] as [string, unknown[]];
    expect(values).toEqual([CLIENT_ID, NOW.toISOString(), 5]);
  });
});

describe('completeReconciliationExport', () => {
  it('marks a claimed export completed with its result', async () => {
    const { client, query } = mockClient();
    const bucket = { currency: 'USD', claimed: '1.0000' };
    const result = await completeReconciliationExport(client, { clientId: CLIENT_ID, exportId: EXPORT_ID, result: [bucket] });
    expect(result).toEqual({ found: true });
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status IN ('claimed', 'completed')");
    expect(values).toEqual([CLIENT_ID, EXPORT_ID, JSON.stringify([bucket])]);
  });

  it('reports found: false for an unknown export id', async () => {
    const { client, query } = mockClient();
    query.mockImplementationOnce((sql: string) => {
      if (sql.includes('UPDATE reconciliation_export')) return Promise.resolve({ rowCount: 0 });
      throw new Error(`unexpected query: ${sql}`);
    });
    const result = await completeReconciliationExport(client, { clientId: CLIENT_ID, exportId: '30000000-0000-4000-8000-000000000099', result: [] });
    expect(result).toEqual({ found: false });
  });
});

describe('failReconciliationExport', () => {
  it('marks a claimed export failed with the given reason', async () => {
    const { client, query } = mockClient();
    const result = await failReconciliationExport(client, { clientId: CLIENT_ID, exportId: EXPORT_ID, error: 'boom' });
    expect(result).toEqual({ found: true });
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status IN ('claimed', 'failed')");
    expect(values).toEqual([CLIENT_ID, EXPORT_ID, 'boom']);
  });

  it('rejects an empty error message', async () => {
    const { client } = mockClient();
    await expect(failReconciliationExport(client, { clientId: CLIENT_ID, exportId: EXPORT_ID, error: '' })).rejects.toThrow();
  });
});
