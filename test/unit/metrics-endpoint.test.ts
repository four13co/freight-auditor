import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { JOB_NAMES } from '../../src/jobs/contracts.js';
import { renderQueueMetrics, type QueueMetrics } from '../../src/jobs/metrics.js';
import { renderDiscoveryMetrics, type DiscoveryMetrics } from '../../src/jobs/discovery-metrics.js';

/**
 * Request-level unit coverage of GET /metrics via Fastify's .inject(), with
 * db/tenant-context AND the two collectors (collectQueueMetrics,
 * collectDiscoveryMetrics) mocked -- same pattern as
 * claim-recovery-endpoint.test.ts -- so this runs with no live Postgres.
 * The No-go on this task's own item explicitly requires mocking at this
 * boundary rather than a hand-rolled HTTP client mock for the route.
 * renderQueueMetrics/renderDiscoveryMetrics are imported for REAL here (not
 * mocked), so the assertions below are a genuine comparison against their
 * actual output, not a restatement of what the route calls.
 * test/db/metrics-endpoint.db.test.ts covers the same route against a real
 * database (real pgboss schema, real RLS-scoped discovery tables).
 */
const FIXTURE_QUEUE_METRICS: QueueMetrics[] = [
  { queue: JOB_NAMES.EVALUATE_AUDIT_V1, depth: 3, failures: 1, retries: 4, oldestPendingAgeSeconds: 12.5 },
  { queue: JOB_NAMES.PROCESS_INGESTION_V1, depth: 0, failures: 0, retries: 0, oldestPendingAgeSeconds: 0 },
];

const FIXTURE_DISCOVERY_METRICS: DiscoveryMetrics = {
  aiProposalsByModel: [{ modelId: 'claude-opus-5', promptVersion: 'contract-proposed-criteria/1', count: 7 }],
  abstentionsByReason: [{ abstentionReason: 'no_matching_criterion', count: 2 }],
  humanTouchCorrections: 5,
  humanTouchRatifications: 3,
  proposalsByLifecycle: [{ lifecycleStage: 'RATIFIED', count: 3 }],
};

function mockCollectors(options: { queueError?: boolean; discoveryError?: boolean } = {}) {
  vi.doMock('../../src/db/tenant-context.js', () => ({
    withTenantReadTx: vi.fn(async (_ctx: unknown, fn: (client: pg.PoolClient) => unknown) => fn({} as pg.PoolClient)),
  }));
  vi.doMock('../../src/jobs/metrics.js', async () => {
    const actual = await vi.importActual<typeof import('../../src/jobs/metrics.js')>('../../src/jobs/metrics.js');
    return {
      ...actual,
      collectQueueMetrics: options.queueError
        ? vi.fn().mockRejectedValue(new Error('connection refused'))
        : vi.fn().mockResolvedValue(FIXTURE_QUEUE_METRICS),
    };
  });
  vi.doMock('../../src/jobs/discovery-metrics.js', async () => {
    const actual = await vi.importActual<typeof import('../../src/jobs/discovery-metrics.js')>('../../src/jobs/discovery-metrics.js');
    return {
      ...actual,
      collectDiscoveryMetrics: options.discoveryError
        ? vi.fn().mockRejectedValue(new Error('connection refused'))
        : vi.fn().mockResolvedValue(FIXTURE_DISCOVERY_METRICS),
    };
  });
}

describe('GET /metrics (unit, mocked withTenantReadTx + collectors)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.resetModules();
    vi.doUnmock('../../src/db/tenant-context.js');
    vi.doUnmock('../../src/jobs/metrics.js');
    vi.doUnmock('../../src/jobs/discovery-metrics.js');
  });

  it('AC1: returns freight_job_* series in the exact Prometheus text renderQueueMetrics produces for the same input', async () => {
    mockCollectors();
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/metrics' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain(renderQueueMetrics(FIXTURE_QUEUE_METRICS));
    expect(res.body).toContain('freight_job_queue_depth{queue="freight.audit.evaluate.v1"} 3');
    expect(res.body).toContain('freight_job_oldest_pending_age_seconds{queue="freight.audit.evaluate.v1"} 12.5');
  });

  it('AC2: discovery metrics are included alongside the queue metrics in the same response', async () => {
    mockCollectors();
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/metrics' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(renderDiscoveryMetrics(FIXTURE_DISCOVERY_METRICS));
    expect(res.body).toContain('freight_discovery_human_touch_total{kind="extraction_correction"} 5');
    // Both series present in one response, queue metrics first.
    expect(res.body.indexOf('freight_job_queue_depth')).toBeLessThan(res.body.indexOf('freight_ai_proposals_total'));
  });

  it('P6.C.5: includes the replay-integrity-failure counter alongside queue/discovery metrics', async () => {
    const { recordReplayIntegrityFailure, resetReplayAlertMetricsForTest } = await import('../../src/jobs/replay-alert-metrics.js');
    resetReplayAlertMetricsForTest();
    recordReplayIntegrityFailure();
    mockCollectors();
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/metrics' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('freight_replay_integrity_failures_total 1');
    resetReplayAlertMetricsForTest();
  });

  it('P6.C.9: includes the rule-quarantine counter alongside the other alert/queue/discovery metrics', async () => {
    const { recordRuleQuarantine, resetQuarantineAlertMetricsForTest } = await import('../../src/jobs/quarantine-alert-metrics.js');
    resetQuarantineAlertMetricsForTest();
    recordRuleQuarantine();
    mockCollectors();
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/metrics' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('freight_rule_quarantine_total 1');
    resetQuarantineAlertMetricsForTest();
  });

  it('AC4: returns a 5xx (not a misleadingly-empty 200) when the underlying queue-metrics query fails', async () => {
    mockCollectors({ queueError: true });
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/metrics' });

    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(res.statusCode).toBeLessThan(600);
  });

  it('AC4: returns a 5xx when the underlying discovery-metrics query fails', async () => {
    mockCollectors({ discoveryError: true });
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/metrics' });

    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(res.statusCode).toBeLessThan(600);
  });

  it('never includes a raw error message in the response body (pg errors can echo a connection string)', async () => {
    mockCollectors({ queueError: true });
    const { buildApp } = await import('../../src/server/app.js');
    app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/metrics' });

    expect(res.body).not.toContain('connection refused');
  });
});
