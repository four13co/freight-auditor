import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { listFindings } from '../../src/modules/findings/list-findings.js';

/**
 * Unit-level coverage of listFindings' query-building (WHERE clause, param
 * order, LIMIT/OFFSET, row mapping) via a mocked pg client -- no live DB.
 * test/db/list-findings.db.test.ts covers the same function against real
 * Postgres (RLS isolation, joins, the expected_charge dedup) and stays the
 * source of truth for that behavior; this file exists so the default
 * coverage gate (test/db/** excluded) also exercises this module.
 */
function mockRow() {
  return {
    id: 'f1',
    invoice_number: 'INV-1',
    carrier_name: 'ACME',
    billed: '1000.0000',
    expected: '900.0000',
    variance_amount: '100.0000',
    direction: 'OVERCHARGE',
    status: 'open',
    created_at: new Date('2026-01-01T00:00:00Z'),
    rule_description: 'Duplicate invoice for the same PRO' as string | null,
  };
}

function mockClient(rows: ReturnType<typeof mockRow>[]) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('listFindings (unit, mocked client)', () => {
  it('maps a returned row from snake_case columns to the FindingRow shape', async () => {
    const { client } = mockClient([mockRow()]);
    const rows = await listFindings(client, {});
    expect(rows).toEqual([
      {
        id: 'f1',
        invoiceNumber: 'INV-1',
        carrierName: 'ACME',
        billed: '1000.0000',
        expected: '900.0000',
        varianceAmount: '100.0000',
        direction: 'OVERCHARGE',
        status: 'open',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        ruleDescription: 'Duplicate invoice for the same PRO',
      },
    ]);
  });

  it('maps a null rule_description (no criterion attached) to ruleDescription: null (86e2up8c8)', async () => {
    const { client } = mockClient([{ ...mockRow(), rule_description: null }]);
    const rows = await listFindings(client, {});
    expect(rows[0]?.ruleDescription).toBeNull();
  });

  it('builds no outer filter WHERE clause and uses default LIMIT/OFFSET when no filters are given', async () => {
    const { client, query } = mockClient([]);
    await listFindings(client, {});
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    // Two LATERAL subqueries each have their own inner WHERE (joining on
    // charge_fact_id / criterion_id) regardless of filters -- assert no
    // *outer* filter clause follows the LAST LATERAL join's closing paren,
    // rather than a blanket "no WHERE anywhere".
    const afterLastLateral = sql.split('criterion_version ON true')[1];
    expect(afterLastLateral).not.toMatch(/WHERE/);
    expect(params).toEqual([50, 0]);
  });

  it('adds a carrier condition and binds it positionally', async () => {
    const { client, query } = mockClient([]);
    await listFindings(client, { carrier: 'ACME' });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/carrier\.name = \$1/);
    expect(params).toEqual(['ACME', 50, 0]);
  });

  it('adds a status condition cast to variance_status', async () => {
    const { client, query } = mockClient([]);
    await listFindings(client, { status: 'closed' });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/variance_finding\.status = \$1::variance_status/);
    expect(params).toEqual(['closed', 50, 0]);
  });

  it('adds a minAmount condition and combines multiple filters with AND, each at its own param index', async () => {
    const { client, query } = mockClient([]);
    await listFindings(client, { carrier: 'ACME', status: 'open', minAmount: '100.00' });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(
      /carrier\.name = \$1 AND variance_finding\.status = \$2::variance_status AND variance_finding\.variance_amount >= \$3/,
    );
    expect(params).toEqual(['ACME', 'open', '100.00', 50, 0]);
  });

  it('honors explicit limit and offset', async () => {
    const { client, query } = mockClient([]);
    await listFindings(client, { limit: 10, offset: 20 });
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([10, 20]);
  });

  it('returns an empty array when the query has no matching rows', async () => {
    const { client } = mockClient([]);
    const rows = await listFindings(client, {});
    expect(rows).toEqual([]);
  });
});
