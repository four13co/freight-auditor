import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { listPendingPaymentAuthorizations } from '../../src/modules/payments/list-pending-payment-authorizations.js';

/**
 * Unit-level coverage of listPendingPaymentAuthorizations' query-building
 * (WHERE/NOT EXISTS shape, LIMIT/OFFSET, row mapping) via a mocked pg
 * client -- no live DB. test/db/list-pending-payment-authorizations.db.test.ts
 * covers the same function against real Postgres (RLS isolation, exclusion
 * of resolved audit runs) and is the source of truth for that behavior;
 * this file exists so the default coverage gate (test/db/** excluded) also
 * exercises this module, mirroring list-gate-failures.test.ts's split.
 */
function mockRow() {
  return {
    audit_run_id: 'run1',
    invoice_id: 'inv1',
    invoice_number: 'INV-1',
    carrier_name: 'ACME',
    currency: 'USD',
    held_at: new Date('2026-01-01T00:00:00Z'),
    rationale: 'hold-then-approve default' as string | null,
  };
}

function mockClient(rows: ReturnType<typeof mockRow>[]) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('listPendingPaymentAuthorizations (unit, mocked client)', () => {
  it('maps a returned row from snake_case columns to the PendingPaymentAuthorizationRow shape', async () => {
    const { client } = mockClient([mockRow()]);
    const rows = await listPendingPaymentAuthorizations(client, {});
    expect(rows).toEqual([
      {
        auditRunId: 'run1',
        invoiceId: 'inv1',
        invoiceNumber: 'INV-1',
        carrierName: 'ACME',
        currency: 'USD',
        heldAt: new Date('2026-01-01T00:00:00Z'),
        rationale: 'hold-then-approve default',
      },
    ]);
  });

  it('maps a null rationale to rationale: null', async () => {
    const { client } = mockClient([{ ...mockRow(), rationale: null }]);
    const rows = await listPendingPaymentAuthorizations(client, {});
    expect(rows[0]?.rationale).toBeNull();
  });

  it('filters on action = hold and excludes runs with a resolving decision, with default limit/offset', async () => {
    const { client, query } = mockClient([]);
    await listPendingPaymentAuthorizations(client, {});
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/hold\.action = 'hold'/);
    expect(sql).toMatch(/NOT EXISTS/);
    expect(sql).toMatch(/resolved\.action IN \('approve', 'short_pay', 'do_not_pay'\)/);
    expect(params).toEqual([50, 0]);
  });

  it('honors explicit limit and offset', async () => {
    const { client, query } = mockClient([]);
    await listPendingPaymentAuthorizations(client, { limit: 10, offset: 20 });
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([10, 20]);
  });

  it('returns an empty array when the query has no matching rows', async () => {
    const { client } = mockClient([]);
    const rows = await listPendingPaymentAuthorizations(client, {});
    expect(rows).toEqual([]);
  });
});
