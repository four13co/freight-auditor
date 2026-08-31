import PgBoss from 'pg-boss';
import { registerJobQueues } from './policies.js';
import { JOB_NAMES } from './contracts.js';
import { withTenantTx } from '../db/tenant-context.js';
import { APP_ROLE } from '../db/pool.js';
import { handleClaimFollowUpJob } from './claim-follow-up-handler.js';
import { handleClaimEscalationJob } from './claim-escalation-handler.js';
import { handleClaimAgingScanJob } from './claim-aging-scan-handler.js';

type Environment = Record<string, string | undefined>;

export interface WorkerLogger {
  info(message: string): void;
  error(message: string, detail?: { errorName: string }): void;
}

export interface BossLifecycle {
  on(event: 'error', handler: (error: Error) => void): unknown;
  start(): Promise<unknown>;
  createQueue(name: string, options?: PgBoss.Queue): Promise<void>;
  work<ReqData>(name: string, handler: PgBoss.WorkHandler<ReqData>): Promise<string>;
  send: PgBoss['send'];
  schedule(name: string, cron: string, data?: object, options?: PgBoss.ScheduleOptions): Promise<void>;
  stop(options?: PgBoss.StopOptions): Promise<void>;
  getDb(): PgBoss.Db;
}

export interface StartWorkerOptions {
  env?: Environment;
  logger?: WorkerLogger;
  createBoss?: (databaseUrl: string) => BossLifecycle;
}

/** Every 15 minutes: frequent enough that a missed deadline is caught promptly, cheap enough to run as a no-op scan when nothing is due. */
const CLAIM_AGING_SCAN_CRON = '*/15 * * * *';

/**
 * pg-boss creates its own schema and tables at boss.start() -- there is no
 * migration file to grant on ahead of time, since the objects don't exist
 * until this runs. Nothing ever granted freight_app access to them, so
 * enqueueInTransaction (which runs inside a tenant-scoped transaction,
 * i.e. under SET LOCAL ROLE freight_app, not the owner role migrations
 * run as) fails closed with "permission denied for schema pgboss" the
 * first time any real request tries to enqueue a job through it --
 * discovered via the real DB-integration test this task's own Done-when
 * line required (86e31a9dr). Idempotent (IF NOT EXISTS-equivalent via
 * plain GRANT, safe to rerun every boot) and additive: default privileges
 * cover pg-boss's per-queue partition tables it creates after this runs.
 */
export async function grantJobSchemaAccessToAppRole(boss: Pick<BossLifecycle, 'getDb'>): Promise<void> {
  const db = boss.getDb();
  await db.executeSql(`GRANT USAGE ON SCHEMA pgboss TO ${APP_ROLE}`, []);
  await db.executeSql(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO ${APP_ROLE}`, []);
  await db.executeSql(`ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE}`, []);
}

export interface JobConsumerDeps {
  withTenantTx: typeof withTenantTx;
  handleFollowUp: typeof handleClaimFollowUpJob;
  handleEscalation: typeof handleClaimEscalationJob;
  handleScan: typeof handleClaimAgingScanJob;
}

const defaultConsumerDeps: JobConsumerDeps = {
  withTenantTx,
  handleFollowUp: handleClaimFollowUpJob,
  handleEscalation: handleClaimEscalationJob,
  handleScan: handleClaimAgingScanJob,
};

/**
 * Registers the `.work()` consumers this repo actually has handlers for
 * today (the two claim jobs plus the aging scan tick that enqueues them)
 * and schedules the recurring scan. Ingestion/audit/reference-data/SFTP
 * job types are registered as queues (registerJobQueues) but have no
 * consumer wired here yet -- their handlers need object-store/SFTP-client
 * construction that doesn't exist at worker-bootstrap scope, a separate
 * gap from the one this closes.
 */
export async function registerJobConsumers(
  boss: Pick<BossLifecycle, 'work' | 'schedule' | 'send'>,
  deps: JobConsumerDeps = defaultConsumerDeps,
): Promise<void> {
  await boss.work<{ clientId: string }>(JOB_NAMES.FOLLOW_UP_CLAIM_V1, async (jobs) => {
    for (const job of jobs) {
      await deps.withTenantTx({ clientIds: [job.data.clientId] }, (client) =>
        deps.handleFollowUp(client, job.data));
    }
  });

  await boss.work<{ clientId: string }>(JOB_NAMES.ESCALATE_CLAIM_V1, async (jobs) => {
    for (const job of jobs) {
      await deps.withTenantTx({ clientIds: [job.data.clientId] }, (client) =>
        deps.handleEscalation(client, job.data));
    }
  });

  await boss.work(JOB_NAMES.SCAN_CLAIM_AGING_V1, async (jobs) => {
    for (const job of jobs) {
      await deps.handleScan(boss, job.data);
    }
  });

  await boss.schedule(JOB_NAMES.SCAN_CLAIM_AGING_V1, CLAIM_AGING_SCAN_CRON, {
    schemaVersion: 1,
    requestedAt: new Date().toISOString(),
  });
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
  await grantJobSchemaAccessToAppRole(boss);
  await registerJobConsumers(boss);
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
