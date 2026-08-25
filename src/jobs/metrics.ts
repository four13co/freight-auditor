import type PgBoss from 'pg-boss';
import { JOB_NAMES, type JobName } from './contracts.js';

export interface QueueMetrics {
  queue: JobName;
  depth: number;
  failures: number;
  retries: number;
  oldestPendingAgeSeconds: number;
}

interface MetricRow {
  name: JobName;
  depth: string | number;
  failures: string | number;
  retries: string | number;
  oldest_pending_age_seconds: string | number;
}

const METRICS_SQL = `
  SELECT name,
    count(*) FILTER (WHERE state IN ('created', 'retry', 'active')) AS depth,
    count(*) FILTER (WHERE state = 'failed') AS failures,
    coalesce(sum(retry_count), 0) AS retries,
    coalesce(extract(epoch FROM now() - min(created_on)
      FILTER (WHERE state IN ('created', 'retry'))), 0) AS oldest_pending_age_seconds
  FROM pgboss.job
  WHERE name = ANY($1::text[])
  GROUP BY name
`;

export async function collectQueueMetrics(db: PgBoss.Db): Promise<QueueMetrics[]> {
  const names = Object.values(JOB_NAMES);
  const result = await db.executeSql(METRICS_SQL, [names]);
  const rows = new Map((result.rows as MetricRow[]).map((row) => [row.name, row]));
  return names.map((queue) => {
    const row = rows.get(queue);
    return {
      queue,
      depth: Number(row?.depth ?? 0),
      failures: Number(row?.failures ?? 0),
      retries: Number(row?.retries ?? 0),
      oldestPendingAgeSeconds: Number(row?.oldest_pending_age_seconds ?? 0),
    };
  });
}

function label(queue: string): string {
  return `queue="${queue.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function renderQueueMetrics(metrics: QueueMetrics[]): string {
  const lines = [
    '# TYPE freight_job_queue_depth gauge',
    ...metrics.map((m) => `freight_job_queue_depth{${label(m.queue)}} ${m.depth}`),
    '# TYPE freight_job_failures gauge',
    ...metrics.map((m) => `freight_job_failures{${label(m.queue)}} ${m.failures}`),
    '# TYPE freight_job_retries counter',
    ...metrics.map((m) => `freight_job_retries{${label(m.queue)}} ${m.retries}`),
    '# TYPE freight_job_oldest_pending_age_seconds gauge',
    ...metrics.map((m) => `freight_job_oldest_pending_age_seconds{${label(m.queue)}} ${m.oldestPendingAgeSeconds}`),
  ];
  return `${lines.join('\n')}\n`;
}
