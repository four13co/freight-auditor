import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { listGateFailures } from '../../src/modules/findings/list-gate-failures.js';

/**
 * Unit-level coverage of listGateFailures' query-building (WHERE clause,
 * param order, LIMIT/OFFSET, row mapping) via a mocked pg client -- no live
 * DB. test/db/list-gate-failures.db.test.ts covers the same function
 * against real Postgres (RLS isolation, the real pipeline producing rows,
 * structural separation from listFindings) and stays the source of truth
 * for that behavior; this file exists so the default coverage gate
 * (test/db/** excluded) also exercises this module.
 */
function mockRow() {
  return {
    id: 'gf1',
    audit_run_id: 'run1',
    invoice_number: 'INV-1',
    carrier_name: 'ACME',
    defect: 'Declared invoice total foots to the sum of line charges within tolerance.',
    citation: 'Invoice total (B3-07) must equal the sum of billed line items (ΣL1-04).' as string | null,
    recorded_at: new Date('2026-01-01T00:00:00Z'),
  };
}

function mockClient(rows: ReturnType<typeof mockRow>[]) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('listGateFailures (unit, mocked client)', () => {
  it('maps a returned row from snake_case columns to the GateFailureRow shape', async () => {
    const { client } = mockClient([mockRow()]);
    const rows = await listGateFailures(client, {});
    expect(rows).toEqual([
      {
        id: 'gf1',
        auditRunId: 'run1',
        invoiceNumber: 'INV-1',
        carrierName: 'ACME',
        defect: 'Declared invoice total foots to the sum of line charges within tolerance.',
        citation: 'Invoice total (B3-07) must equal the sum of billed line items (ΣL1-04).',
        recordedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
  });

  it('maps a null citation to citation: null', async () => {
    const { client } = mockClient([{ ...mockRow(), citation: null }]);
    const rows = await listGateFailures(client, {});
    expect(rows[0]?.citation).toBeNull();
  });

  it('always filters on outcome = REJECTED_REWORK, with no carrier filter by default', async () => {
    const { client, query } = mockClient([]);
    await listGateFailures(client, {});
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/audit_run\.outcome = 'REJECTED_REWORK'/);
    expect(sql).not.toMatch(/carrier\.name = /);
    expect(params).toEqual([50, 0]);
  });

  it('adds a carrier condition and binds it positionally', async () => {
    const { client, query } = mockClient([]);
    await listGateFailures(client, { carrier: 'ACME' });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/carrier\.name = \$1/);
    expect(params).toEqual(['ACME', 50, 0]);
  });

  it('honors explicit limit and offset', async () => {
    const { client, query } = mockClient([]);
    await listGateFailures(client, { limit: 10, offset: 20 });
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([10, 20]);
  });

  it('returns an empty array when the query has no matching rows', async () => {
    const { client } = mockClient([]);
    const rows = await listGateFailures(client, {});
    expect(rows).toEqual([]);
  });
});
