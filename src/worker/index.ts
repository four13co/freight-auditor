import { startJobWorker } from '../jobs/boss.js';

async function main(): Promise<void> {
  await startJobWorker();
}

void main().catch((error: unknown) => {
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  // Do not print the message: provider errors may contain DATABASE_URL.
  console.error('job worker failed to start', { errorName });
  process.exitCode = 1;
});
