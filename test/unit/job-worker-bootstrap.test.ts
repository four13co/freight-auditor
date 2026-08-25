import { describe, expect, it, vi } from 'vitest';
import PgBoss from 'pg-boss';
import {
  createJobBoss,
  installWorkerShutdown,
  requireWorkerDatabaseUrl,
  startJobWorker,
  type BossLifecycle,
  type WorkerLogger,
} from '../../src/jobs/boss.js';

describe('pg-boss worker bootstrap', () => {
  it('fails closed with a stable error when DATABASE_URL is missing', () => {
    expect(() => requireWorkerDatabaseUrl({})).toThrow('DATABASE_URL is required to start the job worker');
    expect(() => requireWorkerDatabaseUrl({ DATABASE_URL: '   ' })).toThrow('DATABASE_URL is required');
  });

  it('constructs the installed PgBoss implementation', () => {
    expect(createJobBoss('postgresql://worker:secret@db.test/freight')).toBeInstanceOf(PgBoss);
  });

  it('registers runtime-error handling, starts the boss, and logs readiness', async () => {
    let runtimeErrorHandler: ((error: Error) => void) | undefined;
    const boss: BossLifecycle = {
      on: vi.fn((_event, handler) => {
        runtimeErrorHandler = handler;
      }),
      start: vi.fn().mockResolvedValue(undefined),
      createQueue: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const logger: WorkerLogger = { info: vi.fn(), error: vi.fn() };
    const createBoss = vi.fn().mockReturnValue(boss);

    await expect(startJobWorker({
      env: { DATABASE_URL: 'postgresql://worker:secret@db.test/freight' },
      logger,
      createBoss,
    })).resolves.toBe(boss);

    expect(createBoss).toHaveBeenCalledWith('postgresql://worker:secret@db.test/freight');
    expect(boss.start).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith('job worker started');

    runtimeErrorHandler!(new Error('postgresql://worker:secret@db.test/freight'));
    expect(logger.error).toHaveBeenCalledWith('job worker runtime error', { errorName: 'Error' });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain('worker:secret');
  });

  it('propagates startup failures without logging credentials', async () => {
    const failure = new Error('connection refused for postgresql://worker:secret@db.test/freight');
    const boss: BossLifecycle = {
      on: vi.fn(),
      start: vi.fn().mockRejectedValue(failure),
      createQueue: vi.fn(),
      stop: vi.fn(),
    };
    const logger: WorkerLogger = { info: vi.fn(), error: vi.fn() };

    await expect(startJobWorker({
      env: { DATABASE_URL: 'postgresql://worker:secret@db.test/freight' },
      logger,
      createBoss: () => boss,
    })).rejects.toBe(failure);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('drains once on SIGTERM/SIGINT and closes the queue connection', async () => {
    const listeners = new Map<string, () => void>();
    const signals = { once: vi.fn((signal: string, listener: () => void) => listeners.set(signal, listener)) };
    const stop = vi.fn().mockResolvedValue(undefined);
    const logger: WorkerLogger = { info: vi.fn(), error: vi.fn() };
    const onStopped = vi.fn();

    installWorkerShutdown({ stop }, logger, signals as never, onStopped);
    listeners.get('SIGTERM')!();
    listeners.get('SIGINT')!();
    await vi.waitFor(() => expect(onStopped).toHaveBeenCalledOnce());

    expect(stop).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith({ graceful: true, wait: true, close: true, timeout: 30_000 });
    expect(logger.info).toHaveBeenCalledWith('job worker stopped');
  });
});
