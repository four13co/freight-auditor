import type { FastifyInstance } from 'fastify';
import type PgBoss from 'pg-boss';
import { withTenantReadTx } from '../db/tenant-context.js';
import { collectQueueMetrics, renderQueueMetrics } from '../jobs/metrics.js';
import { collectDiscoveryMetrics, renderDiscoveryMetrics } from '../jobs/discovery-metrics.js';
import { renderReplayAlertMetrics } from '../jobs/replay-alert-metrics.js';
import { renderQuarantineAlertMetrics } from '../jobs/quarantine-alert-metrics.js';

/**
 * P6.C.4: makes worker-throughput/queue-backlog + discovery metrics --
 * previously only reachable via the one-shot `npm run worker:metrics` CLI
 * script (src/worker/metrics.ts) -- continuously scrapable over HTTP.
 * Registered at TOP LEVEL like /health/static-routes.ts: unauthenticated,
 * since this reports only aggregate job-queue and discovery counts, never
 * tenant-scoped or PII data, the same posture /health already has.
 *
 * Both collectors run inside ONE read-tenant transaction (withTenantReadTx,
 * scope { internal: true }) rather than a bare pool query against pgboss.job
 * directly:
 * grantJobSchemaAccessToAppRole (src/jobs/boss.ts) grants pgboss.* to the
 * freight_app role specifically, not to whatever role DATABASE_URL logs in
 * as, and collectDiscoveryMetrics's tables are RLS-gated (PR #159's
 * fail-closed defect). SET LOCAL ROLE freight_app inside this transaction
 * is what makes both reads work under the same guarantee regardless of the
 * pool's login role -- see setTenantTxScope's own header for why.
 */
export async function registerMetricsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/metrics', async (_request, reply) => {
    try {
      const [queueMetrics, discoveryMetrics] = await withTenantReadTx({ internal: true }, async (client) => {
        // Sequential, not Promise.all: both collectors share this one
        // transaction's single connection, and issuing a second query
        // before the first settles on the same client is deprecated (pg
        // will reject it outright in pg@9). collectDiscoveryMetrics has
        // its own internal Promise.all across 4 queries on the same client
        // -- a pre-existing pattern elsewhere in this codebase, out of
        // scope for this item to change -- so this sequencing narrows but
        // doesn't eliminate that warning under a real Postgres client.
        const db: PgBoss.Db = { executeSql: (text, values) => client.query(text, values) };
        const queue = await collectQueueMetrics(db);
        const discovery = await collectDiscoveryMetrics(client);
        return [queue, discovery] as const;
      });
      const body = renderQueueMetrics(queueMetrics) + renderDiscoveryMetrics(discoveryMetrics) + renderReplayAlertMetrics() + renderQuarantineAlertMetrics();
      return reply.code(200).type('text/plain; charset=utf-8').send(body);
    } catch (error) {
      // Never log the error message: a pg/network error can echo a connection
      // string (same rationale as boss.ts's boss.on('error') handler). Unlike
      // /health, a failure here means the scrape genuinely got no data, so
      // this returns 503 rather than /health's deliberate never-fail 200.
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      app.log.error({ errorName }, 'metrics collection failed');
      return reply.code(503).type('text/plain; charset=utf-8').send('metrics collection failed\n');
    }
  });
}
