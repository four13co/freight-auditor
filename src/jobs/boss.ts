import PgBoss from 'pg-boss';

type Environment = Record<string, string | undefined>;

export interface WorkerLogger {
  info(message: string): void;
  error(message: string, detail?: { errorName: string }): void;
}

export interface BossLifecycle {
  on(event: 'error', handler: (error: Error) => void): unknown;
  start(): Promise<unknown>;
}

export interface StartWorkerOptions {
  env?: Environment;
  logger?: WorkerLogger;
  createBoss?: (databaseUrl: string) => BossLifecycle;
}

export function requireWorkerDatabaseUrl(env: Environment = process.env): string {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required to start the job worker');
  return databaseUrl;
}

export function createJobBoss(databaseUrl: string): PgBoss {
  return new PgBoss({
    connectionString: databaseUrl,
    application_name: 'freight-auditor-worker',
    schema: 'pgboss',
  });
}

/**
 * Start the dedicated queue process. Queue creation and worker registration
 * deliberately belong to P0/1.B.2; this bootstrap proves the process and
 * database lifecycle before business payloads exist.
 */
export async function startJobWorker(options: StartWorkerOptions = {}): Promise<BossLifecycle> {
  const logger = options.logger ?? console;
  const databaseUrl = requireWorkerDatabaseUrl(options.env);
  const boss = (options.createBoss ?? createJobBoss)(databaseUrl);
  boss.on('error', (error) => {
    // Never log the error message here: pg/network errors can echo a
    // connection string. The error class is enough for the bootstrap signal.
    logger.error('job worker runtime error', { errorName: error.name });
  });
  await boss.start();
  logger.info('job worker started');
  return boss;
}
