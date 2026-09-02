import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { recordPartialRecovery } from '../../src/modules/claims/record-partial-recovery.js';
import { JOB_NAMES } from '../../src/jobs/contracts.js';
import { DEFAULT_RECONCILIATION_EXPORT_SYSTEM_CODE } from '../../src/modules/claims/enqueue-reconciliation-export.js';

const CLIENT_ID = '10000000-0000-4000-8000-000000000001';
const CLAIM_ID = '20000000-0000-4000-8000-000000000001';
const RECOVERY_EVENT_ID = '30000000-0000-4000-8000-000000000001';

function makeClient(): pg.PoolClient {
  const query = vi.fn().mockImplementation(async (sql: string) => {
    if (sql.includes('FROM claim')) {
      return { rows: [{ id: CLAIM_ID, amount_claimed: '500.0000', currency: 'USD' }] };
    }
    if (sql.includes('FROM recovery_event')) {
      return { rows: [{ total: '0' }] };
    }
    if (sql.includes('INSERT INTO recovery_event')) {
      return { rows: [{ id: RECOVERY_EVENT_ID }] };
    }
    if (sql.includes('INSERT INTO audit_event')) {
      return { rows: [{ id: 'audit-id', created: true }] };
    }
    if (sql.includes('SAVEPOINT') || sql.includes('RELEASE') || sql.includes('ROLLBACK')) {
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  return { query } as unknown as pg.PoolClient;
}

/**
 * 86e2zfjjg AC3: recordPartialRecovery's own success never depends on the
 * export attempt (ExportAdapterRegistry/handleExportRecordJob) -- it only
 * needs the enqueue to succeed, since the export runs later, off this
 * request path, via the worker. Proven here structurally: this module's own
 * import graph never reaches export-record-handler.ts/export-adapter.ts (a
 * NOT_CONFIGURED-resolving registry is simply not in this call path), and
 * behaviorally: recordPartialRecovery resolves successfully from a plain
 * mocked `boss.send`, with no adapter/registry involved at all.
 */
describe('recordPartialRecovery -> export enqueue never blocks on the export attempt', () => {
  it('resolves successfully once the export job is enqueued, without invoking any export adapter', async () => {
    const client = makeClient();
    const send = vi.fn().mockResolvedValue('job-id');
    const boss = { send };

    const result = await recordPartialRecovery(client, boss as never, {
      clientId: CLIENT_ID,
      claimId: CLAIM_ID,
      amountRecovered: '200.0000',
      currency: 'USD',
    });

    expect(result).toEqual({
      recoveryEventId: RECOVERY_EVENT_ID,
      cumulativeRecovered: '200.0000',
      isFinal: false,
    });

    expect(send).toHaveBeenCalledTimes(1);
    const [name, payload] = send.mock.calls[0]!;
    expect(name).toBe(JOB_NAMES.EXPORT_RECORD_V1);
    expect(payload).toMatchObject({
      clientId: CLIENT_ID,
      claimId: CLAIM_ID,
      systemCode: DEFAULT_RECONCILIATION_EXPORT_SYSTEM_CODE,
      idempotencyKey: `recovery-export:${RECOVERY_EVENT_ID}`,
      payload: { recoveryEventId: RECOVERY_EVENT_ID, amountRecovered: '200.0000', currency: 'USD' },
    });
  });

  /**
   * The SAVEPOINT fix's own contract (No-gos): a failing enqueue must not
   * throw out of recordPartialRecovery, and the caller's transaction must
   * see a rollback-to-savepoint, never an outer ROLLBACK. Verified here at
   * the query-sequence level (SAVEPOINT -> failed send -> ROLLBACK TO
   * SAVEPOINT, never a bare ROLLBACK), complementing the DB test's proof
   * that the write survives against a real Postgres transaction.
   */
  it('rolls back only to the savepoint, not the whole transaction, when boss.send rejects', async () => {
    const queries: string[] = [];
    const client = makeClient();
    const originalQuery = client.query as unknown as (sql: string, params?: unknown[]) => Promise<unknown>;
    client.query = vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
      queries.push(sql);
      return originalQuery(sql, params);
    }) as never;

    const send = vi.fn().mockRejectedValue(new Error('boom'));
    const boss = { send };

    const result = await recordPartialRecovery(client, boss as never, {
      clientId: CLIENT_ID,
      claimId: CLAIM_ID,
      amountRecovered: '200.0000',
      currency: 'USD',
    });

    expect(result.recoveryEventId).toBe(RECOVERY_EVENT_ID);
    expect(queries.some((q) => q.startsWith('SAVEPOINT'))).toBe(true);
    expect(queries.some((q) => q.startsWith('ROLLBACK TO SAVEPOINT'))).toBe(true);
    expect(queries.some((q) => q === 'ROLLBACK')).toBe(false);
    expect(queries.some((q) => q.startsWith('RELEASE SAVEPOINT'))).toBe(false);
  });
});
