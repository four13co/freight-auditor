import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import PgBoss from 'pg-boss';
import type { FastifyInstance } from 'fastify';
import { closePool } from '../../src/db/pool.js';
import { grantJobSchemaAccessToAppRole } from '../../src/jobs/boss.js';
import { registerJobQueues } from '../../src/jobs/policies.js';
import { JOB_NAMES } from '../../src/jobs/contracts.js';
import { requireDatabaseUrl } from './helpers.js';
import { buildApp } from '../../src/server/app.js';

/**
 * Live-wiring proof for GET /metrics (P6.C.4), complementing the mocked
 * test/unit/metrics-endpoint.test.ts and test/e2e/metrics-endpoint.e2e.test.ts.
 * Boss setup mirrors claim-aging-job-pipeline.db.test.ts (minus consumer
 * registration -- nothing here needs a job actually processed, only
 * enqueued): a real PgBoss against the real ephemeral Postgres,
 * registerJobQueues + grantJobSchemaAccessToAppRole so the pgboss
 * schema/grants exist exactly as they would in production after the
 * worker's first boot. EVALUATE_AUDIT_V1 has no registered consumer
 * (src/jobs/boss.ts's own header: ingestion/audit/reference-data job types
 * are queued but unconsumed), so the job this test enqueues sits in
 * 'created' state for the life of the test -- no race with a handler.
 *
 * This is the test that would catch the permission risk metrics-routes.ts's
 * header comment names: the route reads pgboss.job through a
 * withTenantReadTx transaction (SET LOCAL ROLE freight_app), the exact role
 * grantJobSchemaAccessToAppRole grants -- if that role/grant pairing were
 * ever wrong, this fails with "permission denied for schema pgboss" even
 * though the connecting test-DB user is itself a superuser (see helpers.ts's
 * header) and every mocked unit test would stay green regardless.
 */
describe('GET /metrics against a live database (database)', () => {
  let boss: PgBoss;
  let app: FastifyInstance;

  beforeAll(async () => {
    boss = new PgBoss({ connectionString: requireDatabaseUrl(), schema: 'pgboss' });
    await boss.start();
    await registerJobQueues(boss);
    await grantJobSchemaAccessToAppRole(boss);

    // A real job row so collectQueueMetrics' depth for this queue is
    // genuinely nonzero, not just "didn't error."
    await boss.send(JOB_NAMES.EVALUATE_AUDIT_V1, { auditRunId: 'metrics-endpoint-db-test' });

    app = buildApp();
  });

  afterAll(async () => {
    await app.close();
    await boss.stop({ graceful: true, wait: true, close: true, timeout: 10_000 });
    await closePool();
  });

  it('returns 200 with real queue-depth and discovery-metrics series, no permission error', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');

    // Real row from the boss.send above, read back through pgboss.job under
    // SET LOCAL ROLE freight_app -- proves the grant/role pairing works.
    expect(res.body).toMatch(/freight_job_queue_depth\{queue="freight\.audit\.evaluate\.v1"\} [1-9]\d*/);

    // Discovery metrics ran (RLS-scoped tables, PR #159's fail-closed
    // defect) without throwing -- a permission or RLS-scope failure here
    // would 503, not render these headers.
    expect(res.body).toContain('# TYPE freight_ai_proposals_total counter');
    expect(res.body).toContain('# TYPE freight_discovery_human_touch_total counter');
  });
});
