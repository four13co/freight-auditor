import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type pg from 'pg';
import PgBoss from 'pg-boss';
import { getPool, closePool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import {
  recordPartialRecovery,
  RecordPartialRecoveryError,
} from '../../src/modules/claims/record-partial-recovery.js';
import { PartialRecoveryError } from '../../src/modules/claims/validate-partial-recovery.js';
import { registerJobQueues } from '../../src/jobs/policies.js';
import { grantJobSchemaAccessToAppRole } from '../../src/jobs/boss.js';
import { enqueueReconciliationExport, DEFAULT_RECONCILIATION_EXPORT_SYSTEM_CODE } from '../../src/modules/claims/enqueue-reconciliation-export.js';
import { deterministicJobId } from '../../src/jobs/enqueue.js';
import { JOB_NAMES } from '../../src/jobs/contracts.js';
import { requireDatabaseUrl } from './helpers.js';

/** A stub boss for tests that only exercise recovery accounting, not export enqueue behavior itself. */
function stubBoss(): Pick<PgBoss, 'send'> {
  return { send: vi.fn().mockResolvedValue('job-id') } as unknown as Pick<PgBoss, 'send'>;
}

/**
 * 86e2zfj55: recording partial recovery events against a claim (P5.A.3).
 */
describe('recordPartialRecovery (DB)', () => {
  let pool: pg.Pool;
  let clientAId: string;
  let clientBId: string;
  const tag = `pr-${Date.now()}`;

  beforeAll(async () => {
    pool = getPool();
    const owner = await pool.connect();
    try {
      const a = await owner.query(`INSERT INTO client (name, slug) VALUES ('PR-A', $1) RETURNING id`, [`${tag}-a`]);
      clientAId = a.rows[0].id;
      const b = await owner.query(`INSERT INTO client (name, slug) VALUES ('PR-B', $1) RETURNING id`, [`${tag}-b`]);
      clientBId = b.rows[0].id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    const owner = await pool.connect();
    try {
      await owner.query(`DELETE FROM audit_event WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM recovery_event WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM claim WHERE client_id IN ($1, $2)`, [clientAId, clientBId]);
      await owner.query(`DELETE FROM client WHERE id IN ($1, $2)`, [clientAId, clientBId]);
    } finally {
      owner.release();
    }
    await closePool();
  });

  async function seedClaim(client: pg.PoolClient, opts: { clientId: string; amountClaimed?: string }): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO claim (client_id, amount_claimed, currency, status) VALUES ($1, $2, 'USD', 'open') RETURNING id`,
      [opts.clientId, opts.amountClaimed ?? '500.0000'],
    );
    return rows[0]!.id;
  }

  it('records a first partial recovery below the claimed amount', async () => {
    const result = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, { clientId: clientAId });
      return recordPartialRecovery(client, stubBoss(), { clientId: clientAId, claimId, amountRecovered: '200.0000', currency: 'USD' });
    });

    expect(result.cumulativeRecovered).toBe('200.0000');
    expect(result.isFinal).toBe(false);
  });

  it('accumulates across multiple partial recovery events toward the claimed amount', async () => {
    const result = await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, { clientId: clientAId });
      const boss = stubBoss();
      await recordPartialRecovery(client, boss, { clientId: clientAId, claimId, amountRecovered: '200.0000', currency: 'USD' });
      const second = await recordPartialRecovery(client, boss, { clientId: clientAId, claimId, amountRecovered: '300.0000', currency: 'USD' });

      const rows = await client.query(`SELECT amount_recovered FROM recovery_event WHERE claim_id = $1 ORDER BY recorded_at`, [claimId]);
      return { second, count: rows.rows.length };
    });

    expect(result.second.cumulativeRecovered).toBe('500.0000');
    expect(result.second.isFinal).toBe(true);
    expect(result.count).toBe(2);
  });

  it('rejects a recovery that would push the cumulative total past the claimed amount', async () => {
    await withTenantTx({ clientIds: [clientAId] }, async (client) => {
      const claimId = await seedClaim(client, { clientId: clientAId });
      const boss = stubBoss();
      await recordPartialRecovery(client, boss, { clientId: clientAId, claimId, amountRecovered: '400.0000', currency: 'USD' });
      await expect(
        recordPartialRecovery(client, boss, { clientId: clientAId, claimId, amountRecovered: '200.0000', currency: 'USD' }),
      ).rejects.toBeInstanceOf(PartialRecoveryError);

      const rows = await client.query(`SELECT id FROM recovery_event WHERE claim_id = $1`, [claimId]);
      expect(rows.rows).toHaveLength(1);
    });
  });

  it('fails not-found for a claim belonging to a different tenant', async () => {
    const claimId = await withTenantTx({ clientIds: [clientAId] }, (client) => seedClaim(client, { clientId: clientAId }));

    await expect(
      withTenantTx({ clientIds: [clientBId] }, (client) =>
        recordPartialRecovery(client, stubBoss(), { clientId: clientBId, claimId, amountRecovered: '100.0000', currency: 'USD' }),
      ),
    ).rejects.toBeInstanceOf(RecordPartialRecoveryError);
  });

  it('fails not-found for a nonexistent claim id', async () => {
    await expect(
      withTenantTx({ clientIds: [clientAId] }, (client) =>
        recordPartialRecovery(client, stubBoss(), {
          clientId: clientAId,
          claimId: '00000000-0000-0000-0000-000000000000',
          amountRecovered: '100.0000',
          currency: 'USD',
        }),
      ),
    ).rejects.toBeInstanceOf(RecordPartialRecoveryError);
  });
});

/**
 * 86e2zfjjg (P5.C.5): recordPartialRecovery's own reconciliation-export
 * enqueue, against a real PgBoss instance -- not a stub -- because the
 * dedupe assertion below needs the real deterministic-job-id/no-op-on-
 * collision behavior pg-boss itself provides, the same reasoning
 * claim-aging-job-pipeline.db.test.ts's own dedupe test uses.
 */
describe('recordPartialRecovery -> reconciliation export enqueue (DB)', () => {
  const tag = `pr-export-${Date.now()}`;
  let boss: PgBoss;
  let clientId: string;

  beforeAll(async () => {
    boss = new PgBoss({ connectionString: requireDatabaseUrl(), schema: 'pgboss' });
    await boss.start();
    await registerJobQueues(boss);
    await grantJobSchemaAccessToAppRole(boss);

    clientId = (await getPool().query(
      `INSERT INTO client (name, slug) VALUES ('PR Export Co', $1) RETURNING id`,
      [tag],
    )).rows[0].id;
  });

  afterAll(async () => {
    await boss.stop({ graceful: false, close: true });
    await getPool().query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM recovery_event WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM claim WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM client WHERE id = $1`, [clientId]);
    await closePool();
  });

  async function seedClaim(client: pg.PoolClient, amountClaimed = '500.0000'): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO claim (client_id, amount_claimed, currency, status) VALUES ($1, $2, 'USD', 'open') RETURNING id`,
      [clientId, amountClaimed],
    );
    return rows[0]!.id;
  }

  it('enqueues an EXPORT_RECORD_V1 job carrying the recovery event reconciliation data when the transaction commits', async () => {
    const { claimId, recoveryEventId } = await withTenantTx({ clientIds: [clientId] }, async (client) => {
      const claimId = await seedClaim(client);
      const result = await recordPartialRecovery(client, boss, {
        clientId,
        claimId,
        amountRecovered: '150.0000',
        currency: 'USD',
      });
      return { claimId, recoveryEventId: result.recoveryEventId };
    });

    const expectedJobId = deterministicJobId(JOB_NAMES.EXPORT_RECORD_V1, clientId, `recovery-export:${recoveryEventId}`);
    const { rows } = await getPool().query<{ data: Record<string, unknown> }>(
      `SELECT data FROM pgboss.job WHERE name = $1 AND id = $2`,
      [JOB_NAMES.EXPORT_RECORD_V1, expectedJobId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toMatchObject({
      clientId,
      claimId,
      systemCode: DEFAULT_RECONCILIATION_EXPORT_SYSTEM_CODE,
      payload: {
        recoveryEventId,
        claimId,
        amountRecovered: '150.0000',
        currency: 'USD',
        varianceFindingId: null,
      },
    });
  });

  it('does not create a duplicate export job for the same recovery_event id enqueued twice', async () => {
    const claimId = await withTenantTx({ clientIds: [clientId] }, (client) => seedClaim(client));
    const recoveryEventId = '00000000-0000-4000-8000-0000000000aa';

    const first = await withTenantTx({ clientIds: [clientId] }, (client) =>
      enqueueReconciliationExport(client, boss, {
        clientId,
        claimId,
        recoveryEventId,
        amountRecovered: '75.0000',
        currency: 'USD',
        varianceFindingId: null,
      }));
    const second = await withTenantTx({ clientIds: [clientId] }, (client) =>
      enqueueReconciliationExport(client, boss, {
        clientId,
        claimId,
        recoveryEventId,
        amountRecovered: '75.0000',
        currency: 'USD',
        varianceFindingId: null,
      }));

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.jobId).toBe(first.jobId);

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS count FROM pgboss.job WHERE name = $1 AND id = $2`,
      [JOB_NAMES.EXPORT_RECORD_V1, first.jobId],
    );
    expect(rows[0].count).toBe(1);
  });
});
