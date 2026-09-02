import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { handleExportRecordJob, ExportRecordFailedError, type ExportRecordJobDeps } from '../../src/jobs/export-record-handler.js';
import { JobPayloadValidationError } from '../../src/jobs/contracts.js';
import type { ExportResult } from '../../src/modules/exports/export-adapter.js';

const CLIENT_ID = '10000000-0000-4000-8000-000000000001';
const CLAIM_ID = '20000000-0000-4000-8000-000000000001';

const basePayload = {
  schemaVersion: 1 as const,
  clientId: CLIENT_ID,
  idempotencyKey: 'export:invoice-1',
  requestedAt: '2026-09-02T00:00:00.000Z',
  claimId: CLAIM_ID,
  paymentGateDecisionId: null,
  systemCode: 'QUICKBOOKS',
  payload: { amount: 100 },
};

function fakeClient(): pg.PoolClient {
  return { query: vi.fn() } as unknown as pg.PoolClient;
}

function depsWithResult(result: ExportResult): ExportRecordJobDeps {
  return {
    registry: { export: vi.fn().mockResolvedValue(result) } as unknown as ExportRecordJobDeps['registry'],
    recordAcknowledgement: vi.fn().mockResolvedValue({ id: 'ack-1', created: true }),
  };
}

describe('handleExportRecordJob', () => {
  it('calls ExportAdapterRegistry.export and persists an ACKNOWLEDGED result via recordExportAcknowledgement', async () => {
    const client = fakeClient();
    const result: ExportResult = { status: 'ACKNOWLEDGED', externalReference: 'ext-1', adapterVersion: 'v1' };
    const deps = depsWithResult(result);

    await handleExportRecordJob(client, basePayload, deps);

    expect(deps.registry.export).toHaveBeenCalledWith(client, {
      systemCode: 'QUICKBOOKS',
      dedupeKey: 'export:invoice-1',
      payload: { amount: 100 },
    });
    expect(deps.recordAcknowledgement).toHaveBeenCalledWith(client, {
      clientId: CLIENT_ID,
      claimId: CLAIM_ID,
      paymentGateDecisionId: null,
      record: { systemCode: 'QUICKBOOKS', dedupeKey: 'export:invoice-1' },
      result,
    });
  });

  it('re-delivery of an already-ACKNOWLEDGED record calls recordExportAcknowledgement again but relies on its own idempotency, not a second export handler concern', async () => {
    const client = fakeClient();
    const result: ExportResult = { status: 'ACKNOWLEDGED', externalReference: 'ext-1', adapterVersion: 'v1' };
    const deps = depsWithResult(result);
    (deps.recordAcknowledgement as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'ack-1', created: false });

    await handleExportRecordJob(client, basePayload, deps);
    await handleExportRecordJob(client, basePayload, deps);

    expect(deps.recordAcknowledgement).toHaveBeenCalledTimes(2);
    expect((deps.recordAcknowledgement as ReturnType<typeof vi.fn>).mock.results[1]!.value).resolves.toEqual({ id: 'ack-1', created: false });
  });

  it('persists a FAILED result and still throws so the queue retries', async () => {
    const client = fakeClient();
    const result: ExportResult = { status: 'FAILED', reason: 'TIMEOUT', adapterVersion: 'v1' };
    const deps = depsWithResult(result);

    await expect(handleExportRecordJob(client, basePayload, deps)).rejects.toBeInstanceOf(ExportRecordFailedError);

    expect(deps.recordAcknowledgement).toHaveBeenCalledWith(client, expect.objectContaining({
      result,
    }));
  });

  it('does not persist anything and completes without throwing for a NOT_CONFIGURED result', async () => {
    const client = fakeClient();
    const result: ExportResult = { status: 'NOT_CONFIGURED', systemCode: 'NETSUITE' };
    const deps = depsWithResult(result);

    await expect(handleExportRecordJob(client, basePayload, deps)).resolves.toBeUndefined();

    expect(deps.recordAcknowledgement).not.toHaveBeenCalled();
  });

  it('rejects an invalid payload before any adapter call', async () => {
    const client = fakeClient();
    const deps = depsWithResult({ status: 'ACKNOWLEDGED', externalReference: 'ext-1', adapterVersion: 'v1' });

    await expect(handleExportRecordJob(client, { ...basePayload, systemCode: '' }, deps))
      .rejects.toBeInstanceOf(JobPayloadValidationError);

    expect(deps.registry.export).not.toHaveBeenCalled();
  });
});
