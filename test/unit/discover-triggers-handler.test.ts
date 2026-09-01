import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_NAMES } from '../../src/jobs/contracts.js';

const detectUnassessableTriggers = vi.fn();
const detectUnknownChargeCodeTriggers = vi.fn();
const detectSuspiciousPassTriggers = vi.fn();

vi.mock('../../src/modules/discovery/detect-unassessable-triggers.js', () => ({ detectUnassessableTriggers }));
vi.mock('../../src/modules/discovery/detect-unknown-charge-code-triggers.js', () => ({ detectUnknownChargeCodeTriggers }));
vi.mock('../../src/modules/discovery/detect-suspicious-pass-triggers.js', () => ({ detectSuspiciousPassTriggers }));

const { handleDiscoverTriggersJob } = await import('../../src/jobs/discover-triggers-handler.js');

const clientId = '11111111-1111-4111-8111-111111111111';
const auditRunId = '22222222-2222-4222-8222-222222222222';
const base = {
  schemaVersion: 1 as const,
  clientId,
  idempotencyKey: 'discover-2026-08-25T12:00Z',
  requestedAt: '2026-08-25T12:00:00.000Z',
};

describe(JOB_NAMES.DISCOVER_TRIGGERS_V1, () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs all three audit-run-scoped detectors and combines their results', async () => {
    detectUnassessableTriggers.mockResolvedValue({ triggerIds: ['a'], createdCount: 1 });
    detectUnknownChargeCodeTriggers.mockResolvedValue({ triggerIds: ['b'], createdCount: 1 });
    detectSuspiciousPassTriggers.mockResolvedValue({ triggerIds: ['c'], createdCount: 1 });

    const db = {} as never;
    const result = await handleDiscoverTriggersJob(db, { ...base, auditRunId });

    expect(detectUnassessableTriggers).toHaveBeenCalledWith(db, { clientId, auditRunId });
    expect(detectUnknownChargeCodeTriggers).toHaveBeenCalledWith(db, { clientId, auditRunId });
    expect(detectSuspiciousPassTriggers).toHaveBeenCalledWith(db, { clientId, auditRunId });
    expect(result).toEqual({
      unassessable: { triggerIds: ['a'], createdCount: 1 },
      unknownChargeCode: { triggerIds: ['b'], createdCount: 1 },
      suspiciousPass: { triggerIds: ['c'], createdCount: 1 },
    });
  });

  it('rejects malformed queue input before dispatching to any detector', async () => {
    await expect(handleDiscoverTriggersJob({} as never, { ...base }))
      .rejects.toMatchObject({ code: 'JOB_PAYLOAD_INVALID' });
    expect(detectUnassessableTriggers).not.toHaveBeenCalled();
  });

  it('rejects an unknown field before dispatching to any detector', async () => {
    await expect(handleDiscoverTriggersJob({} as never, { ...base, auditRunId, extra: 'nope' }))
      .rejects.toMatchObject({ code: 'JOB_PAYLOAD_INVALID' });
    expect(detectUnassessableTriggers).not.toHaveBeenCalled();
  });

  it('propagates a detector fail-closed error without swallowing it', async () => {
    class Boom extends Error { readonly code = 'AUDIT_RUN_NOT_FOUND'; }
    detectUnassessableTriggers.mockRejectedValueOnce(new Boom());

    await expect(handleDiscoverTriggersJob({} as never, { ...base, auditRunId }))
      .rejects.toMatchObject({ code: 'AUDIT_RUN_NOT_FOUND' });
    expect(detectUnknownChargeCodeTriggers).not.toHaveBeenCalled();
  });
});
