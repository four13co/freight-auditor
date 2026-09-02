import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { listClientAuditEvents } from '../../src/modules/portal/list-client-audit-events.js';

const CLIENT_ID = 'client-abc';

function mockClient(rows: unknown[] = []) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('listClientAuditEvents (unit, mocked client)', () => {
  it('maps rows from snake_case to camelCase', async () => {
    const { client } = mockClient([
      { id: 'e1', entity: 'dispute', entity_id: 'd1', event: 'created', actor_kind: 'analyst', recorded_at: new Date('2026-01-01T00:00:00Z') },
    ]);
    const result = await listClientAuditEvents(client, CLIENT_ID);
    expect(result).toEqual([
      { id: 'e1', entity: 'dispute', entityId: 'd1', event: 'created', actorKind: 'analyst', recordedAt: new Date('2026-01-01T00:00:00Z') },
    ]);
  });

  it('always includes an explicit client_id = $1 predicate, as $1', async () => {
    const { client, query } = mockClient();
    await listClientAuditEvents(client, CLIENT_ID);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/WHERE client_id = \$1/);
    expect(params[0]).toBe(CLIENT_ID);
  });

  it('orders newest-first by recorded_at DESC', async () => {
    const { client, query } = mockClient();
    await listClientAuditEvents(client, CLIENT_ID);
    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ORDER BY recorded_at DESC/);
  });

  it('defaults to a bounded limit (not an unbounded query) when no limit is given', async () => {
    const { client, query } = mockClient();
    await listClientAuditEvents(client, CLIENT_ID);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/LIMIT \$\d+ OFFSET \$\d+/);
    expect(params[params.length - 2]).toBe(50);
    expect(params[params.length - 1]).toBe(0);
  });

  it('binds an explicit limit and offset, in that order, as the trailing two params', async () => {
    const { client, query } = mockClient();
    await listClientAuditEvents(client, CLIENT_ID, { limit: 10, offset: 20 });
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params[params.length - 2]).toBe(10);
    expect(params[params.length - 1]).toBe(20);
  });

  it('adds an entity filter only when provided', async () => {
    const { client, query } = mockClient();
    await listClientAuditEvents(client, CLIENT_ID, { entity: 'dispute' });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/entity = \$2/);
    expect(params[1]).toBe('dispute');
  });

  it('adds an event filter only when provided', async () => {
    const { client, query } = mockClient();
    await listClientAuditEvents(client, CLIENT_ID, { event: 'created' });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/event = \$2/);
    expect(params[1]).toBe('created');
  });

  it('adds from/to date-range filters only when provided, in order', async () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-02-01T00:00:00Z');
    const { client, query } = mockClient();
    await listClientAuditEvents(client, CLIENT_ID, { from, to });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/recorded_at >= \$2/);
    expect(sql).toMatch(/recorded_at <= \$3/);
    expect(params[1]).toBe(from);
    expect(params[2]).toBe(to);
  });

  it('combines all filters with AND, params in call order', async () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const { client, query } = mockClient();
    await listClientAuditEvents(client, CLIENT_ID, { entity: 'dispute', event: 'created', from, limit: 5, offset: 0 });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/WHERE client_id = \$1 AND entity = \$2 AND event = \$3 AND recorded_at >= \$4/);
    expect(params).toEqual([CLIENT_ID, 'dispute', 'created', from, 5, 0]);
  });

  it('does not select the detail column', async () => {
    const { client, query } = mockClient();
    await listClientAuditEvents(client, CLIENT_ID);
    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toMatch(/detail/);
  });
});
