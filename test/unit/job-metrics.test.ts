import { describe, expect, it, vi } from 'vitest';
import { JOB_NAMES } from '../../src/jobs/contracts.js';
import { collectQueueMetrics, renderQueueMetrics } from '../../src/jobs/metrics.js';

describe('job metrics', () => {
  it('collects depth, failures, retry attempts, and oldest pending age with zero rows for idle queues', async () => {
    const executeSql = vi.fn().mockResolvedValue({ rows: [{
      name: JOB_NAMES.EVALUATE_AUDIT_V1,
      depth: '3',
      failures: '1',
      retries: '4',
      oldest_pending_age_seconds: '12.5',
    }] });
    const metrics = await collectQueueMetrics({ executeSql });

    expect(executeSql).toHaveBeenCalledWith(expect.stringContaining('FROM pgboss.job'), [Object.values(JOB_NAMES)]);
    expect(metrics.find((m) => m.queue === JOB_NAMES.EVALUATE_AUDIT_V1)).toEqual({
      queue: JOB_NAMES.EVALUATE_AUDIT_V1,
      depth: 3,
      failures: 1,
      retries: 4,
      oldestPendingAgeSeconds: 12.5,
    });
    expect(metrics.find((m) => m.queue === JOB_NAMES.REPLAY_AUDIT_V1)?.depth).toBe(0);
  });

  it('renders scrape-compatible metrics for every required signal', () => {
    const text = renderQueueMetrics([{
      queue: JOB_NAMES.PROCESS_INGESTION_V1,
      depth: 2,
      failures: 1,
      retries: 3,
      oldestPendingAgeSeconds: 45,
    }]);
    expect(text).toContain('freight_job_queue_depth{queue="freight.ingestion.process.v1"} 2');
    expect(text).toContain('freight_job_failures{queue="freight.ingestion.process.v1"} 1');
    expect(text).toContain('freight_job_retries{queue="freight.ingestion.process.v1"} 3');
    expect(text).toContain('freight_job_oldest_pending_age_seconds{queue="freight.ingestion.process.v1"} 45');
  });
});
