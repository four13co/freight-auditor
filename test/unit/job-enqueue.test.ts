import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from '../../src/db/pool.js';
import { JOB_NAMES } from '../../src/jobs/contracts.js';
import {
  deterministicJobId,
  enqueueInTransaction,
  JobTenantMismatchError,
} from '../../src/jobs/enqueue.js';

const clientId = '10000000-0000-4000-8000-000000000001';
const payload = {
  schemaVersion: 1 as const,
  clientId,
  idempotencyKey: 'audit:run-1:evaluate:v1',
  requestedAt: '2026-08-25T18:00:00-05:00',
  auditRunId: '10000000-0000-4000-8000-000000000002',
};

describe('transactional enqueue', () => {
  it('uses the caller transaction connection and a deterministic job id', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'row' }] });
    const client = { query } as unknown as PoolClient;
    const send = vi.fn(async (_name, _data, options) => {
      await options.db.executeSql('insert job', ['value']);
      return options.id;
    });

    const first = await enqueueInTransaction({ send } as never, client, clientId, JOB_NAMES.EVALUATE_AUDIT_V1, payload);
    const second = await enqueueInTransaction({ send } as never, client, clientId, JOB_NAMES.EVALUATE_AUDIT_V1, payload);

    expect(first).toEqual({ jobId: deterministicJobId(JOB_NAMES.EVALUATE_AUDIT_V1, clientId, payload.idempotencyKey), inserted: true });
    expect(second.jobId).toBe(first.jobId);
    expect(query).toHaveBeenCalledWith('insert job', ['value']);
    expect(send.mock.calls[0]?.[2]).toMatchObject({ id: first.jobId, db: { executeSql: expect.any(Function) } });
  });

  it('reports an idempotent duplicate without inventing a second id', async () => {
    const send = vi.fn().mockResolvedValue(null);
    const result = await enqueueInTransaction(
      { send } as never,
      {} as PoolClient,
      clientId,
      JOB_NAMES.EVALUATE_AUDIT_V1,
      payload,
    );
    expect(result).toEqual({
      jobId: deterministicJobId(JOB_NAMES.EVALUATE_AUDIT_V1, clientId, payload.idempotencyKey),
      inserted: false,
    });
  });

  it('fails closed before queue access when the payload crosses tenants', async () => {
    const send = vi.fn();
    await expect(enqueueInTransaction(
      { send } as never,
      {} as PoolClient,
      '20000000-0000-4000-8000-000000000001',
      JOB_NAMES.EVALUATE_AUDIT_V1,
      payload,
    )).rejects.toBeInstanceOf(JobTenantMismatchError);
    expect(send).not.toHaveBeenCalled();
  });

  it('gives different job families and tenants different idempotency domains', () => {
    const key = 'same-key';
    expect(deterministicJobId(JOB_NAMES.EVALUATE_AUDIT_V1, clientId, key)).not.toBe(
      deterministicJobId(JOB_NAMES.REPLAY_AUDIT_V1, clientId, key),
    );
    expect(deterministicJobId(JOB_NAMES.EVALUATE_AUDIT_V1, clientId, key)).not.toBe(
      deterministicJobId(JOB_NAMES.EVALUATE_AUDIT_V1, '20000000-0000-4000-8000-000000000001', key),
    );
  });
});
