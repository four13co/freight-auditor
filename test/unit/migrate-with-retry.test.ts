import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { migrateWithRetry, main } from '../../scripts/migrate-with-retry.mjs';

/**
 * Unit coverage of migrateWithRetry's retry-decision logic via an injectable
 * spawnImpl (no real subprocess, no real DB). The real end-to-end behavior --
 * two actual concurrent `migrate up` processes against real Postgres both
 * exiting 0 -- is the item's own AC and is proven by
 * test/e2e/migrate-race.e2e.test.ts, not here.
 */
/**
 * Returns a THUNK, not the child itself -- constructing the fake child
 * (and scheduling its close event) must happen at the moment spawnImpl is
 * actually invoked, not when the test body sets up the mock. Building it
 * eagerly races runOnce's listener attachment against the queued microtask
 * (whichever wins is non-deterministic and can hang the test).
 */
function fakeChild({ code, stderr = '', stdout = '' }: { code: number; stderr?: string; stdout?: string }) {
  return () => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', code);
    });
    return child;
  };
}

describe('migrateWithRetry', () => {
  it('returns 0 immediately on the first successful attempt, no retry', async () => {
    const spawnImpl = vi.fn().mockImplementation(fakeChild({ code: 0 }));
    const sleepImpl = vi.fn();

    const code = await migrateWithRetry(['up'], { spawnImpl, sleepImpl });

    expect(code).toBe(0);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledWith('node-pg-migrate', ['up']);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it('retries on the lock-contention error and succeeds on the next attempt', async () => {
    const spawnImpl = vi
      .fn()
      .mockImplementationOnce(fakeChild({ code: 1, stderr: 'Error: Another migration is already running\n' }))
      .mockImplementationOnce(fakeChild({ code: 0 }));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    const code = await migrateWithRetry(['up'], { spawnImpl, sleepImpl, maxRetries: 3, retryDelayMs: 5 });

    expect(code).toBe(0);
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).toHaveBeenCalledWith(5);
  });

  it('uses the real setTimeout-based sleep by default when no sleepImpl is injected', async () => {
    const spawnImpl = vi
      .fn()
      .mockImplementationOnce(fakeChild({ code: 1, stderr: 'Error: Another migration is already running\n' }))
      .mockImplementationOnce(fakeChild({ code: 0 }));

    const code = await migrateWithRetry(['up'], { spawnImpl, retryDelayMs: 1 });
    expect(code).toBe(0);
  });

  it('gives up and returns the failing code after exhausting maxRetries, still lock contention', async () => {
    const spawnImpl = vi
      .fn()
      .mockImplementation(fakeChild({ code: 1, stderr: 'Error: Another migration is already running\n' }));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    const code = await migrateWithRetry(['up'], { spawnImpl, sleepImpl, maxRetries: 2, retryDelayMs: 1 });

    expect(code).toBe(1);
    expect(spawnImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(sleepImpl).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a genuinely broken migration (non-lock-contention failure)', async () => {
    const spawnImpl = vi
      .fn()
      .mockImplementation(fakeChild({ code: 1, stderr: 'Error: column "foo" does not exist\n' }));
    const sleepImpl = vi.fn();

    const code = await migrateWithRetry(['up'], { spawnImpl, sleepImpl, maxRetries: 3 });

    expect(code).toBe(1);
    expect(spawnImpl).toHaveBeenCalledTimes(1); // no retry attempted
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it('passes arguments straight through to node-pg-migrate (e.g. "create <name>")', async () => {
    const spawnImpl = vi.fn().mockImplementation(fakeChild({ code: 0 }));

    await migrateWithRetry(['create', 'my-migration', '--migration-file-language', 'sql'], { spawnImpl });

    expect(spawnImpl).toHaveBeenCalledWith('node-pg-migrate', [
      'create',
      'my-migration',
      '--migration-file-language',
      'sql',
    ]);
  });

  it('forwards the child process stdout to this process (progress output stays visible)', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const spawnImpl = vi.fn().mockImplementation(fakeChild({ code: 0, stdout: 'Migrations complete!\n' }));
      await migrateWithRetry(['up'], { spawnImpl });
      expect(writeSpy).toHaveBeenCalledWith(Buffer.from('Migrations complete!\n'));
    } finally {
      writeSpy.mockRestore();
    }
  });
});

describe('main() (in-process, injected argv/exit/migrateImpl)', () => {
  it('runs migrateImpl with the given argv and exits with its returned code', async () => {
    const migrateImpl = vi.fn().mockResolvedValue(0);
    const exit = vi.fn();

    await main({ argv: ['up'], exit, migrateImpl });

    expect(migrateImpl).toHaveBeenCalledWith(['up']);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits with the failing code when migrateImpl does not resolve to 0', async () => {
    const migrateImpl = vi.fn().mockResolvedValue(1);
    const exit = vi.fn();

    await main({ argv: ['up'], exit, migrateImpl });

    expect(exit).toHaveBeenCalledWith(1);
  });
});
