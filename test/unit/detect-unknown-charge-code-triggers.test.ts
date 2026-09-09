import { describe, expect, it, vi } from 'vitest';
import { detectUnknownChargeCodeTriggers } from '../../src/modules/discovery/detect-unknown-charge-code-triggers.js';

const clientId = '11111111-1111-4111-8111-111111111111';
const auditRunId = '21111111-1111-4111-8111-111111111111';
const invoiceId = '31111111-1111-4111-8111-111111111111';
const chargeFactId = '41111111-1111-4111-8111-111111111111';

function mockClient(opts: { chargeRows?: Array<{ id: string; code: string | null; x12_element: string | null }>; inserted?: boolean }) {
  const chargeRows = opts.chargeRows ?? [];
  const inserted = opts.inserted ?? true;
  const query = vi.fn().mockImplementation(async (sql: string, values: unknown[]) => {
    if (sql.includes('FROM audit_run')) return { rows: [{ invoice_id: invoiceId }] };
    if (sql.includes('FROM charge_fact')) return { rows: chargeRows };
    // insertIdempotent() issues one combined WITH-CTE query (86e367r7f) --
    // both the insert-succeeded and fallback-existing cases are simulated
    // from this single branch now, keyed on the same charge_fact_id param.
    if (sql.includes('INSERT INTO unknown_charge_code_trigger')) {
      const chargeFactIdParam = (values as unknown[])[2];
      return inserted
        ? { rows: [{ id: `trigger-for-${chargeFactIdParam}`, created: true }] }
        : { rows: [{ id: `existing-for-${chargeFactIdParam}`, created: false }] };
    }
    if (sql.includes('audit_event')) return { rows: [{ id: 'audit-event-id', created: true }] };
    throw new Error(`unexpected query: ${sql}`);
  });
  return { query } as never;
}

describe('detectUnknownChargeCodeTriggers', () => {
  it('throws when the audit run does not exist for the tenant', async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => (sql.includes('FROM audit_run') ? { rows: [] } : { rows: [] }));
    await expect(detectUnknownChargeCodeTriggers({ query } as never, { clientId, auditRunId }))
      .rejects.toMatchObject({ code: 'AUDIT_RUN_NOT_FOUND' });
  });

  it('creates a trigger for each charge_fact row with a null category', async () => {
    const client = mockClient({ chargeRows: [{ id: chargeFactId, code: 'FSC', x12_element: 'L108' }] });
    const result = await detectUnknownChargeCodeTriggers(client, { clientId, auditRunId });
    expect(result.createdCount).toBe(1);
    expect(result.triggerIds).toEqual([`trigger-for-${chargeFactId}`]);
  });

  it('is idempotent: a second run against the same rows creates nothing new', async () => {
    const client = mockClient({ chargeRows: [{ id: chargeFactId, code: 'FSC', x12_element: 'L108' }], inserted: false });
    const result = await detectUnknownChargeCodeTriggers(client, { clientId, auditRunId });
    expect(result.createdCount).toBe(0);
    expect(result.triggerIds).toEqual([`existing-for-${chargeFactId}`]);
  });

  it('returns no triggers when every charge_fact row is already categorized', async () => {
    const client = mockClient({ chargeRows: [] });
    const result = await detectUnknownChargeCodeTriggers(client, { clientId, auditRunId });
    expect(result.createdCount).toBe(0);
    expect(result.triggerIds).toEqual([]);
  });

  it('rejects malformed identifiers before querying', async () => {
    const query = vi.fn();
    await expect(detectUnknownChargeCodeTriggers({ query } as never, { clientId: 'not-a-uuid', auditRunId }))
      .rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('86e367r7f: the idempotent fallback path issues one round trip, not two', async () => {
    const client = mockClient({ chargeRows: [{ id: chargeFactId, code: 'FSC', x12_element: 'L108' }], inserted: false });
    await detectUnknownChargeCodeTriggers(client, { clientId, auditRunId });
    // audit_run lookup + charge_fact lookup + one combined insert-or-fetch query + audit event write = 4.
    // The old two-statement insert-then-fallback-SELECT form issued a 5th call here on a conflict.
    expect((client as unknown as { query: ReturnType<typeof vi.fn> }).query).toHaveBeenCalledTimes(4);
  });
});
