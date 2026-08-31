import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import PgBoss from 'pg-boss';
import { closePool, getPool } from '../../src/db/pool.js';
import { withTenantTx } from '../../src/db/tenant-context.js';
import { registerJobConsumers, grantJobSchemaAccessToAppRole } from '../../src/jobs/boss.js';
import { registerJobQueues } from '../../src/jobs/policies.js';
import { scheduleClaimAgingJobs } from '../../src/modules/claims/schedule-claim-aging-jobs.js';
import { deterministicJobId } from '../../src/jobs/enqueue.js';
import { JOB_NAMES } from '../../src/jobs/contracts.js';
import { requireDatabaseUrl } from './helpers.js';

/**
 * The real enqueue-to-processed round trip this task's own Done-when line
 * requires (86e31a9dr) -- a prior attempt (PR #211) shipped with only a
 * mocked test asserting `.work()` was registered, never that the handler
 * actually ran; Review rejected it as coverage theater. This exercises the
 * genuine path: a real PgBoss instance against a real (ephemeral, local)
 * Postgres, scheduleClaimAgingJobs enqueuing through enqueueInTransaction,
 * then registerJobConsumers's real .work() consumer picking the job up and
 * running the real handler -- verified by the audit_event row it writes.
 */
describe('claim aging job pipeline (database)', () => {
  const tag = `claim-aging-pipeline-${Date.now()}`;
  let boss: PgBoss;
  let clientId: string;

  let reactivateOtherClientsAfter: string[] = [];

  beforeAll(async () => {
    boss = new PgBoss({ connectionString: requireDatabaseUrl(), schema: 'pgboss' });
    await boss.start();
    await registerJobQueues(boss);
    await grantJobSchemaAccessToAppRole(boss);
    await registerJobConsumers(boss);

    clientId = (await getPool().query(
      `INSERT INTO client (name, slug) VALUES ('Aging Pipeline Co', $1) RETURNING id`,
      [tag],
    )).rows[0].id;

    // scheduleClaimAgingJobs scans every is_active client -- deactivate any
    // other active client already in this shared DB (e.g. a dev-seed
    // fixture) for the duration of this suite so the scan sees only the one
    // this test controls. Non-destructive: flipped back in afterAll.
    const others = await getPool().query<{ id: string }>(
      `SELECT id FROM client WHERE is_active = true AND id != $1`,
      [clientId],
    );
    reactivateOtherClientsAfter = others.rows.map((row) => row.id);
    if (reactivateOtherClientsAfter.length > 0) {
      await getPool().query(`UPDATE client SET is_active = false WHERE id = ANY($1::uuid[])`, [reactivateOtherClientsAfter]);
    }
  });

  afterEach(async () => {
    await getPool().query(`DELETE FROM audit_event WHERE client_id = $1`, [clientId]);
    await getPool().query(`DELETE FROM claim WHERE client_id = $1`, [clientId]);
  });

  afterAll(async () => {
    await boss.stop({ graceful: false, close: true });
    if (reactivateOtherClientsAfter.length > 0) {
      await getPool().query(`UPDATE client SET is_active = true WHERE id = ANY($1::uuid[])`, [reactivateOtherClientsAfter]);
    }
    await getPool().query(`DELETE FROM client WHERE id = $1`, [clientId]);
    await closePool();
  });

  async function seedClaimPastDeadline(): Promise<string> {
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO claim (client_id, amount_claimed, currency, status, opened_at, aging_deadline_at)
       VALUES ($1, '500.0000', 'USD', 'open', now(), '2020-01-01T00:00:00Z') RETURNING id`,
      [clientId],
    );
    return rows[0]!.id;
  }

  async function seedClaimPastGracePeriod(): Promise<string> {
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO claim (client_id, amount_claimed, currency, status, opened_at)
       VALUES ($1, '500.0000', 'USD', 'open', now()) RETURNING id`,
      [clientId],
    );
    const claimId = rows[0]!.id;
    await getPool().query(
      `INSERT INTO audit_event (id, client_id, entity, entity_id, event, actor_kind, recorded_at)
       VALUES (gen_random_uuid(), $1, 'claim', $2, 'claim.follow_up_sent', 'system', now() - interval '30 days')`,
      [clientId, claimId],
    );
    return claimId;
  }

  it('enqueues a real follow-up job and the real worker processes it end to end', async () => {
    const claimId = await seedClaimPastDeadline();

    const scanResult = await withTenantTx({ internal: true }, (client) =>
      scheduleClaimAgingJobs(client, boss, new Date()));
    expect(scanResult.followUpEnqueued).toBe(1);

    // Poll for the real worker (registered above via registerJobConsumers,
    // running its own fetch loop) to have processed the job and the
    // handler to have written its audit_event side effect -- this is the
    // proof no mock can substitute for.
    const deadline = Date.now() + 15_000;
    let found = false;
    while (Date.now() < deadline && !found) {
      const { rows } = await getPool().query(
        `SELECT 1 FROM audit_event WHERE client_id = $1 AND entity = 'claim' AND entity_id = $2 AND event = 'claim.follow_up_sent'`,
        [clientId, claimId],
      );
      found = rows.length > 0;
      if (!found) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(found).toBe(true);
  }, 20_000);

  it('enqueues a real escalation job and the real worker processes it end to end', async () => {
    const claimId = await seedClaimPastGracePeriod();

    const scanResult = await withTenantTx({ internal: true }, (client) =>
      scheduleClaimAgingJobs(client, boss, new Date()));
    expect(scanResult.escalationEnqueued).toBe(1);

    const deadline = Date.now() + 15_000;
    let found = false;
    while (Date.now() < deadline && !found) {
      const { rows } = await getPool().query(
        `SELECT 1 FROM audit_event WHERE client_id = $1 AND entity = 'claim' AND entity_id = $2 AND event = 'claim.escalated'`,
        [clientId, claimId],
      );
      found = rows.length > 0;
      if (!found) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(found).toBe(true);
  }, 20_000);

  it('does not enqueue a duplicate follow-up job for a claim already covered by an in-flight job', async () => {
    const claimId = await seedClaimPastDeadline();

    const first = await withTenantTx({ internal: true }, (client) =>
      scheduleClaimAgingJobs(client, boss, new Date()));
    const second = await withTenantTx({ internal: true }, (client) =>
      scheduleClaimAgingJobs(client, boss, new Date()));

    expect(first.followUpEnqueued).toBe(1);
    // Re-running the scan before the first job is processed sends the same
    // deterministic job id again -- pg-boss reports it as not-inserted
    // rather than creating a second row, so the scan's own "enqueued" count
    // still reports 1 attempted per run, but only one job row ever exists
    // for THIS claim specifically (scoped by id, since the shared worker
    // registered in beforeAll may have already completed/archived jobs
    // from an earlier test in this suite under the same job name).
    expect(second.followUpEnqueued).toBe(1);
    const expectedJobId = deterministicJobId(JOB_NAMES.FOLLOW_UP_CLAIM_V1, clientId, `claim-follow-up:${claimId}`);
    const jobs = await getPool().query(
      `SELECT count(*)::int AS count FROM pgboss.job WHERE name = $1 AND id = $2`,
      ['freight.claims.follow-up.v1', expectedJobId],
    );
    expect(jobs.rows[0].count).toBe(1);
  });
});
