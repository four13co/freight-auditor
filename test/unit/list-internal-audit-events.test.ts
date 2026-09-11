import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { listInternalAuditEvents } from '../../src/modules/audit-ledger/list-internal-audit-events.js';

function mockClient(rows: unknown[] = []) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('listInternalAuditEvents (unit, mocked client)', () => {
  it('maps rows from snake_case to camelCase', async () => {
    const { client } = mockClient([
      { id: 'e1', entity: 'dispute', entity_id: 'd1', event: 'created', actor_kind: 'analyst', recorded_at: new Date('2026-01-01T00:00:00Z') },
    ]);
    const result = await listInternalAuditEvents(client);
    expect(result).toEqual([
      { id: 'e1', entity: 'dispute', entityId: 'd1', event: 'created', actorKind: 'analyst', recordedAt: new Date('2026-01-01T00:00:00Z') },
    ]);
  });

  it('issues no client_id predicate at all -- cross-client by design, safety is RLS alone', async () => {
    const { client, query } = mockClient();
    await listInternalAuditEvents(client);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toMatch(/client_id/);
    expect(sql).not.toMatch(/WHERE.*AND/);
    // Only limit/offset are bound when no filters are given.
    expect(params).toEqual([50, 0]);
  });

  it('orders newest-first by recorded_at DESC', async () => {
    const { client, query } = mockClient();
    await listInternalAuditEvents(client);
    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ORDER BY recorded_at DESC/);
  });

  it('defaults to a bounded limit (not an unbounded query) when no limit is given', async () => {
    const { client, query } = mockClient();
    await listInternalAuditEvents(client);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/LIMIT \$\d+ OFFSET \$\d+/);
    expect(params[params.length - 2]).toBe(50);
    expect(params[params.length - 1]).toBe(0);
  });

  it('binds an explicit limit and offset, in that order, as the trailing two params', async () => {
    const { client, query } = mockClient();
    await listInternalAuditEvents(client, { limit: 10, offset: 20 });
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params[params.length - 2]).toBe(10);
    expect(params[params.length - 1]).toBe(20);
  });

  it('adds an entity filter only when provided, as the first bound param', async () => {
    const { client, query } = mockClient();
    await listInternalAuditEvents(client, { entity: 'dispute' });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/WHERE entity = \$1/);
    expect(params[0]).toBe('dispute');
  });

  it('adds an event filter only when provided', async () => {
    const { client, query } = mockClient();
    await listInternalAuditEvents(client, { event: 'created' });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/WHERE event = \$1/);
    expect(params[0]).toBe('created');
  });

  it('adds from/to date-range filters only when provided, in order', async () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-02-01T00:00:00Z');
    const { client, query } = mockClient();
    await listInternalAuditEvents(client, { from, to });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/recorded_at >= \$1/);
    expect(sql).toMatch(/recorded_at <= \$2/);
    expect(params[0]).toBe(from);
    expect(params[1]).toBe(to);
  });

  it('combines all filters with AND, params in call order', async () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const { client, query } = mockClient();
    await listInternalAuditEvents(client, { entity: 'dispute', event: 'created', from, limit: 5, offset: 0 });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/WHERE entity = \$1 AND event = \$2 AND recorded_at >= \$3/);
    expect(params).toEqual(['dispute', 'created', from, 5, 0]);
  });

  it('does not select the detail column', async () => {
    const { client, query } = mockClient();
    await listInternalAuditEvents(client);
    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toMatch(/detail/);
  });
});
