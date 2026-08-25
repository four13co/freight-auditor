import { createJobBoss, requireWorkerDatabaseUrl } from '../jobs/boss.js';
import { collectQueueMetrics, renderQueueMetrics } from '../jobs/metrics.js';

async function main(): Promise<void> {
  const boss = createJobBoss(requireWorkerDatabaseUrl());
  try {
    await boss.start();
    process.stdout.write(renderQueueMetrics(await collectQueueMetrics(boss.getDb())));
  } finally {
    await boss.stop({ graceful: true, wait: true, close: true, timeout: 10_000 });
  }
}

void main().catch((error: unknown) => {
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  console.error('job metrics collection failed', { errorName });
  process.exitCode = 1;
});
