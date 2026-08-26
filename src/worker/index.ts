import { installWorkerShutdown, startJobWorker } from '../jobs/boss.js';

async function main(): Promise<void> {
  const boss = await startJobWorker();
  installWorkerShutdown(boss);
}

void main().catch((error: unknown) => {
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  // Do not print the message: provider errors may contain DATABASE_URL.
  console.error('job worker failed to start', { errorName });
  process.exitCode = 1;
});
