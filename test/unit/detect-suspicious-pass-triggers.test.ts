import { describe, expect, it, vi } from 'vitest';
import { detectSuspiciousPassTriggers } from '../../src/modules/discovery/detect-suspicious-pass-triggers.js';

const clientId = '11111111-1111-4111-8111-111111111111';
const auditRunId = '21111111-1111-4111-8111-111111111111';
const markerId = '41111111-1111-4111-8111-111111111111';

function mockClient(opts: { markerRows?: Array<{ id: string; charge_index: number; marker_code: string; missing_fields: string[] }>; inserted?: boolean }) {
  const markerRows = opts.markerRows ?? [];
  const inserted = opts.inserted ?? true;
  const query = vi.fn().mockImplementation(async (sql: string, values: unknown[]) => {
    if (sql.includes('FROM audit_run')) return { rows: [{}], rowCount: 1 };
    if (sql.includes('FROM coverage_marker')) return { rows: markerRows };
    if (sql.startsWith('INSERT INTO suspicious_pass_trigger')) {
      return inserted ? { rows: [{ id: `trigger-for-${(values as unknown[])[2]}` }] } : { rows: [] };
    }
    if (sql.startsWith('SELECT id FROM suspicious_pass_trigger')) {
      return { rows: [{ id: `existing-for-${(values as unknown[])[1]}` }] };
    }
    if (sql.includes('audit_event')) return { rows: [{ id: 'audit-event-id', created: true }] };
    throw new Error(`unexpected query: ${sql}`);
  });
  return { query } as never;
}

describe('detectSuspiciousPassTriggers', () => {
  it('throws when the audit run does not exist for the tenant', async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => (sql.includes('FROM audit_run') ? { rows: [], rowCount: 0 } : { rows: [] }));
    await expect(detectSuspiciousPassTriggers({ query } as never, { clientId, auditRunId }))
      .rejects.toMatchObject({ code: 'AUDIT_RUN_NOT_FOUND' });
  });

  it('creates a trigger for each coverage_marker row', async () => {
    const client = mockClient({ markerRows: [{ id: markerId, charge_index: 0, marker_code: 'INCOMPLETE_RATE_BASIS', missing_fields: ['basis'] }] });
    const result = await detectSuspiciousPassTriggers(client, { clientId, auditRunId });
    expect(result.createdCount).toBe(1);
    expect(result.triggerIds).toEqual([`trigger-for-${markerId}`]);
  });

  it('is idempotent: a second run against the same rows creates nothing new', async () => {
    const client = mockClient({ markerRows: [{ id: markerId, charge_index: 0, marker_code: 'INCOMPLETE_RATE_BASIS', missing_fields: ['basis'] }], inserted: false });
    const result = await detectSuspiciousPassTriggers(client, { clientId, auditRunId });
    expect(result.createdCount).toBe(0);
    expect(result.triggerIds).toEqual([`existing-for-${markerId}`]);
  });

  it('returns no triggers when the audit run has no coverage markers', async () => {
    const client = mockClient({ markerRows: [] });
    const result = await detectSuspiciousPassTriggers(client, { clientId, auditRunId });
    expect(result.createdCount).toBe(0);
    expect(result.triggerIds).toEqual([]);
  });

  it('rejects malformed identifiers before querying', async () => {
    const query = vi.fn();
    await expect(detectSuspiciousPassTriggers({ query } as never, { clientId: 'not-a-uuid', auditRunId }))
      .rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});
