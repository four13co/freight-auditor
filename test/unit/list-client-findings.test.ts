import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { listClientFindings } from '../../src/modules/portal/list-client-findings.js';

/**
 * Unit-level coverage of listClientFindings' query-building (client_id
 * predicate, WHERE clause, param order, LIMIT/OFFSET, row mapping) via a
 * mocked pg client -- no live DB. Mirrors list-findings.test.ts's own
 * structure exactly; the added coverage here is the explicit
 * `variance_finding.client_id = $1` predicate (86e31a9ch/#216 precedent)
 * that list-findings.ts deliberately does NOT have (RLS-only).
 * test/db/portal-content-routes.db.test.ts covers the same function
 * against real Postgres, including the cross-tenant isolation proof.
 */
function mockRow() {
  return {
    id: 'f1',
    audit_run_id: 'r1',
    invoice_id: 'i1',
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

const CLIENT_ID = 'client-abc';

describe('listClientFindings (unit, mocked client)', () => {
  it('maps a returned row from snake_case columns to the ClientFindingRow shape', async () => {
    const { client } = mockClient([mockRow()]);
    const rows = await listClientFindings(client, CLIENT_ID, {});
    expect(rows).toEqual([
      {
        id: 'f1',
        auditRunId: 'r1',
        invoiceId: 'i1',
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

  it('maps a null rule_description to ruleDescription: null', async () => {
    const { client } = mockClient([{ ...mockRow(), rule_description: null }]);
    const rows = await listClientFindings(client, CLIENT_ID, {});
    expect(rows[0]?.ruleDescription).toBeNull();
  });

  it('always binds clientId as the first param, ahead of any other filter', async () => {
    const { client, query } = mockClient([]);
    await listClientFindings(client, CLIENT_ID, { carrier: 'ACME', status: 'open', minAmount: '100.00' });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/WHERE variance_finding\.client_id = \$1 AND carrier\.name = \$2 AND variance_finding\.status = \$3::variance_status AND variance_finding\.variance_amount >= \$4/);
    expect(params).toEqual([CLIENT_ID, 'ACME', 'open', '100.00', 50, 0]);
  });

  it('builds only the client_id predicate and uses default LIMIT/OFFSET when no other filters are given', async () => {
    const { client, query } = mockClient([]);
    await listClientFindings(client, CLIENT_ID, {});
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    const afterLastLateral = sql.split('criterion_version ON true')[1]!;
    expect(afterLastLateral).toMatch(/WHERE variance_finding\.client_id = \$1\s*$/m);
    expect(params).toEqual([CLIENT_ID, 50, 0]);
  });

  it('adds a carrier condition and binds it positionally after clientId', async () => {
    const { client, query } = mockClient([]);
    await listClientFindings(client, CLIENT_ID, { carrier: 'ACME' });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/carrier\.name = \$2/);
    expect(params).toEqual([CLIENT_ID, 'ACME', 50, 0]);
  });

  it('honors explicit limit and offset', async () => {
    const { client, query } = mockClient([]);
    await listClientFindings(client, CLIENT_ID, { limit: 10, offset: 20 });
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([CLIENT_ID, 10, 20]);
  });

  it('returns an empty array when the query has no matching rows', async () => {
    const { client } = mockClient([]);
    const rows = await listClientFindings(client, CLIENT_ID, {});
    expect(rows).toEqual([]);
  });

  it('has no clientIds field in ListClientFindingsOptions -- the client scope is bound structurally by the clientId param, never a caller-supplied filter', async () => {
    const { client, query } = mockClient([]);
    // @ts-expect-error -- clientIds is deliberately not part of this options shape (unlike list-findings.ts's ListFindingsOptions).
    await listClientFindings(client, CLIENT_ID, { clientIds: ['other-client'] });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    // Passing an extraneous clientIds key has no effect on the query -- the
    // only client-scoping predicate is the one bound to the clientId param.
    expect(sql).not.toMatch(/other-client/);
    expect(params).toEqual([CLIENT_ID, 50, 0]);
  });

  describe('sort', () => {
    it('defaults to ORDER BY created_at DESC when no sort is requested', async () => {
      const { client, query } = mockClient([]);
      await listClientFindings(client, CLIENT_ID, {});
      const [sql] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/ORDER BY variance_finding\.created_at DESC/);
    });

    it('sorts by variance_amount, ASC, with NULLS LAST', async () => {
      const { client, query } = mockClient([]);
      await listClientFindings(client, CLIENT_ID, { sort: 'variance', sortDir: 'asc' });
      const [sql] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/ORDER BY variance_finding\.variance_amount ASC NULLS LAST/);
    });

    it('sorts by created_at when sort: "age" is requested, with no NULLS LAST', async () => {
      const { client, query } = mockClient([]);
      await listClientFindings(client, CLIENT_ID, { sort: 'age', sortDir: 'asc' });
      const [sql] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/ORDER BY variance_finding\.created_at ASC(?! NULLS LAST)/);
    });

    it('ORDER BY always comes before the outer LIMIT/OFFSET, regardless of sort', async () => {
      const { client, query } = mockClient([]);
      await listClientFindings(client, CLIENT_ID, { sort: 'variance', sortDir: 'asc', limit: 10, offset: 5 });
      const [sql] = query.mock.calls[0] as [string, unknown[]];
      const orderIdx = sql.indexOf('ORDER BY');
      const outerLimitIdx = sql.search(/LIMIT \$\d+ OFFSET \$\d+/);
      expect(orderIdx).toBeGreaterThan(-1);
      expect(outerLimitIdx).toBeGreaterThan(orderIdx);
    });
  });
});
