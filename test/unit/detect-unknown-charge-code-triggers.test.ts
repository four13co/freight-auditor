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
    if (sql.startsWith('INSERT INTO unknown_charge_code_trigger')) {
      return inserted ? { rows: [{ id: `trigger-for-${(values as unknown[])[2]}` }] } : { rows: [] };
    }
    if (sql.startsWith('SELECT id FROM unknown_charge_code_trigger')) {
      return { rows: [{ id: `existing-for-${(values as unknown[])[1]}` }] };
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
});
