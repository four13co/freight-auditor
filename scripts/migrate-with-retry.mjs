#!/usr/bin/env node
// Wraps node-pg-migrate with a retry-with-backoff around ONE specific,
// transient failure: two `migrate up` runs firing close together both grab
// node-pg-migrate's own advisory lock, and the loser fails with "Another
// migration is already running" (86e2unvbv -- reproduced 2026-08-14 by
// racing two real concurrent `node-pg-migrate up` invocations against an
// ephemeral local Postgres: the run right after a lock failure succeeds
// cleanly once the winner releases it, so a short retry is sufficient).
//
// Matches on that exact error text, not "any nonzero exit" -- a blanket
// retry would mask a genuinely broken migration by retrying it a few times
// and then failing anyway with a confusing log. `--lock false` was
// considered and rejected: it removes contention *detection* rather than
// handling it, trading a loud flake for silent concurrent DDL.
//
// This IS the root `migrate` npm script (see package.json) -- deploy.yml's
// `npm run migrate up` therefore already runs the fixed path with no
// workflow edit needed, so there's no wrapper/caller divergence for a test
// to miss (86e2u72u2 lesson: the untested path is the broken path).

import { spawn } from 'node:child_process';

const LOCK_ERROR_PATTERN = /Another migration is already running/;

/**
 * Spawn node-pg-migrate with `args`, capturing stderr to check for the lock
 * error. Resolves with the exit code and captured stderr; never rejects on
 * a nonzero exit (the caller decides whether to retry).
 *
 * @param {string[]} args
 * @param {object} [opts]
 * @param {(cmd: string, args: string[]) => import('node:child_process').ChildProcess} [opts.spawnImpl] - injectable for tests
 * @returns {Promise<{ code: number, stderr: string }>}
 */
function runOnce(args, { spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl('node-pg-migrate', args);
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });
    child.stdout?.on('data', (chunk) => {
      process.stdout.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stderr }));
  });
}

/**
 * Run node-pg-migrate with `args`, retrying up to `maxRetries` times ONLY
 * when the failure is the lock-contention error. Any other nonzero exit
 * (a genuinely broken migration) is returned immediately, unretried.
 *
 * @param {string[]} args
 * @param {object} [opts]
 * @param {number} [opts.maxRetries]
 * @param {number} [opts.retryDelayMs]
 * @param {(cmd: string, args: string[]) => import('node:child_process').ChildProcess} [opts.spawnImpl]
 * @param {(ms: number) => Promise<void>} [opts.sleepImpl]
 * @param {(msg: string) => void} [opts.logInfo]
 * @returns {Promise<number>} the final exit code
 */
export async function migrateWithRetry(
  args,
  { maxRetries = 3, retryDelayMs = 2000, spawnImpl = spawn, sleepImpl = defaultSleep, logInfo = console.log } = {},
) {
  // The loop always returns from inside its own body: on the final
  // iteration (attempt === maxRetries) the `attempt === maxRetries` check
  // below is true regardless of isLockContention, so there is no
  // fall-through case -- nothing follows the loop.
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const { code, stderr } = await runOnce(args, { spawnImpl });
    if (code === 0) return 0;

    const isLockContention = LOCK_ERROR_PATTERN.test(stderr);
    if (!isLockContention || attempt === maxRetries) return code;

    logInfo(
      `migrate-with-retry: lock contention (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${retryDelayMs}ms...`,
    );
    await sleepImpl(retryDelayMs);
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The CLI body, factored out so tests can drive it in-process (injectable
 * argv/exit/migrateImpl) instead of only via a subprocess -- a subprocess
 * call exercises real behavior but is invisible to v8 coverage
 * instrumentation in the parent process (86e2u72u2).
 *
 * @param {object} [opts]
 * @param {string[]} [opts.argv]
 * @param {(code?: number) => void} [opts.exit]
 * @param {typeof migrateWithRetry} [opts.migrateImpl]
 */
export async function main({ argv = process.argv.slice(2), exit = process.exit, migrateImpl = migrateWithRetry } = {}) {
  const code = await migrateImpl(argv);
  exit(code);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
