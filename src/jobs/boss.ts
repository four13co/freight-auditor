import PgBoss from 'pg-boss';
import { registerJobQueues } from './policies.js';

type Environment = Record<string, string | undefined>;

export interface WorkerLogger {
  info(message: string): void;
  error(message: string, detail?: { errorName: string }): void;
}

export interface BossLifecycle {
  on(event: 'error', handler: (error: Error) => void): unknown;
  start(): Promise<unknown>;
  createQueue(name: string, options?: PgBoss.Queue): Promise<void>;
  stop(options?: PgBoss.StopOptions): Promise<void>;
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
    supervise: true,
    maintenanceIntervalSeconds: 30,
  });
}

/**
 * Start the dedicated queue process and register its durable queue policies.
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
  await registerJobQueues(boss);
  logger.info('job worker started');
  return boss;
}

interface SignalSource {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
}

export function installWorkerShutdown(
  boss: Pick<BossLifecycle, 'stop'>,
  logger: WorkerLogger = console,
  signals: SignalSource = process,
  onStopped: () => void = () => undefined,
): void {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    logger.info('job worker stopping');
    void boss.stop({ graceful: true, wait: true, close: true, timeout: 30_000 })
      .then(() => {
        logger.info('job worker stopped');
        onStopped();
      })
      .catch((error: unknown) => {
        const errorName = error instanceof Error ? error.name : 'UnknownError';
        logger.error('job worker shutdown error', { errorName });
        onStopped();
      });
  };
  signals.once('SIGTERM', stop);
  signals.once('SIGINT', stop);
}
