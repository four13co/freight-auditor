import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { getClientAuditRunScorecard } from '../../src/modules/portal/get-client-audit-run-scorecard.js';

const CLIENT_ID = '40000000-0000-4000-8000-000000000001';
const AUDIT_RUN_ID = '40000000-0000-4000-8000-000000000002';

function mockClient(rows: unknown[] = []) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { client: { query } as unknown as pg.PoolClient, query };
}

describe('getClientAuditRunScorecard', () => {
  it('returns null when no matching row is found', async () => {
    const { client } = mockClient([]);
    const result = await getClientAuditRunScorecard(client, CLIENT_ID, AUDIT_RUN_ID);
    expect(result).toBeNull();
  });

  it('maps a row to the camelCase shape', async () => {
    const { client } = mockClient([
      {
        audit_run_id: AUDIT_RUN_ID, invoice_id: 'inv-1', invoice_number: 'INV-100', outcome: 'SCORED',
        conformed_count: 8, variance_count: 2, unassessable_count: 0,
        total_overcharge: '150.0000', total_undercharge: '10.0000', currency: 'USD',
      },
    ]);
    const result = await getClientAuditRunScorecard(client, CLIENT_ID, AUDIT_RUN_ID);
    expect(result).toEqual({
      auditRunId: AUDIT_RUN_ID, invoiceId: 'inv-1', invoiceNumber: 'INV-100', outcome: 'SCORED',
      conformedCount: 8, varianceCount: 2, unassessableCount: 0,
      totalOvercharge: '150.0000', totalUndercharge: '10.0000', currency: 'USD',
    });
  });

  it('passes null through for a row with no scorecard yet (REJECTED_REWORK, LEFT JOINed scorecard is absent)', async () => {
    const { client } = mockClient([
      {
        audit_run_id: AUDIT_RUN_ID, invoice_id: 'inv-1', invoice_number: 'INV-100', outcome: 'REJECTED_REWORK',
        conformed_count: null, variance_count: null, unassessable_count: null,
        total_overcharge: null, total_undercharge: null, currency: null,
      },
    ]);
    const result = await getClientAuditRunScorecard(client, CLIENT_ID, AUDIT_RUN_ID);
    expect(result).toEqual({
      auditRunId: AUDIT_RUN_ID, invoiceId: 'inv-1', invoiceNumber: 'INV-100', outcome: 'REJECTED_REWORK',
      conformedCount: null, varianceCount: null, unassessableCount: null,
      totalOvercharge: null, totalUndercharge: null, currency: null,
    });
  });

  it('scopes the query to auditRunId then clientId as the two parameters', async () => {
    const { client, query } = mockClient([]);
    await getClientAuditRunScorecard(client, CLIENT_ID, AUDIT_RUN_ID);
    expect(query.mock.calls[0]![1]).toEqual([AUDIT_RUN_ID, CLIENT_ID]);
  });

  it('filters on ar.client_id, not just ar.id, as the explicit predicate', async () => {
    const { client, query } = mockClient([]);
    await getClientAuditRunScorecard(client, CLIENT_ID, AUDIT_RUN_ID);
    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ar.id = $1 AND ar.client_id = $2');
  });
});
