import { describe, expect, it, vi } from 'vitest';
import { handleDiscoverTriggersJob } from '../../src/jobs/discover-triggers-handler.js';
import { JOB_NAMES } from '../../src/jobs/contracts.js';
import { DiscoveryTriggerError } from '../../src/modules/discovery/detect-unassessable-triggers.js';

const clientId = '11111111-1111-4111-8111-111111111111';
const auditRunId = '22222222-2222-4222-8222-222222222222';

const payload = {
  schemaVersion: 1 as const,
  clientId,
  auditRunId,
  idempotencyKey: `discover-triggers:${auditRunId}:v1`,
  requestedAt: '2026-08-28T00:00:00.000Z',
};

describe(JOB_NAMES.DISCOVER_TRIGGERS_V1, () => {
  it('dispatches to detectUnassessableTriggers with the parsed tenant-scoped input', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ '?column?': 1 }] }) // audit_run existence check
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no unassessable sources
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'audit-event-id' }] }); // writeAuditEvent insert
    const db = { query } as never;

    const result = await handleDiscoverTriggersJob(db, payload);

    expect(result).toEqual({ triggerIds: [], createdCount: 0 });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM audit_run'),
      [clientId, auditRunId],
    );
  });

  it('rejects malformed queue input before querying tenant data', async () => {
    const query = vi.fn();
    const db = { query } as never;

    await expect(handleDiscoverTriggersJob(db, { ...payload, clientId: 'nope' }))
      .rejects.toMatchObject({ code: 'JOB_PAYLOAD_INVALID' });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects an unknown queue name field the schema does not expect', async () => {
    const query = vi.fn();
    const db = { query } as never;

    await expect(handleDiscoverTriggersJob(db, { ...payload, extra: 'nope' }))
      .rejects.toMatchObject({ code: 'JOB_PAYLOAD_INVALID' });
    expect(query).not.toHaveBeenCalled();
  });

  it('propagates a fail-closed DiscoveryTriggerError when the audit run is missing', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const db = { query } as never;

    await expect(handleDiscoverTriggersJob(db, payload)).rejects.toBeInstanceOf(DiscoveryTriggerError);
  });
});
