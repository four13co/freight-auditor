#!/usr/bin/env node
// 86e33t7yu: every occurrence of the list-findings.db.test.ts flake so far
// has been unrecoverable evidence -- "flaked, non-reproducible" with no
// captured assertion diff or error, because retrying (correctly, to unblock
// the round) discarded the only failing output that existed. Process fix
// named explicitly in that task's own Solution section, "do regardless of
// root cause": wrap test:db so ANY failure -- this flake or a future one --
// always writes its full combined stdout/stderr to disk before anyone gets
// a chance to retry and lose it.
//
// Passthrough on success: this changes nothing about the normal path (live
// output still streams, exit code still propagates) -- it only adds a
// side effect on failure.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_FAILURE_DIR = '.test-failures';

/**
 * Runs `command` with `args`, streaming stdout/stderr through live exactly
 * like a normal invocation. On a non-zero exit, writes the full combined
 * output (in the order received) to a timestamped file under `failureDir`
 * and returns its path alongside the exit code.
 *
 * @param {object} opts
 * @param {string} opts.command
 * @param {string[]} opts.args
 * @param {string} [opts.failureDir]
 * @param {() => string} [opts.now] - injectable for deterministic filenames in tests
 * @returns {Promise<{ code: number, capturedTo: string | null }>}
 */
export function runWithFailureCapture({ command, args, failureDir = DEFAULT_FAILURE_DIR, now = () => new Date().toISOString() }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'] });
    let output = '';

    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      output += chunk;
    });

    child.on('error', reject);
    child.on('close', (code) => {
      const exitCode = code ?? 1;
      if (exitCode === 0) {
        resolve({ code: exitCode, capturedTo: null });
        return;
      }
      mkdirSync(failureDir, { recursive: true });
      const filePath = join(failureDir, `test-db-failure-${now().replace(/[:.]/g, '-')}.log`);
      writeFileSync(filePath, output);
      process.stderr.write(`\ntest:db failed -- full output captured to ${filePath}\n`);
      resolve({ code: exitCode, capturedTo: filePath });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { code } = await runWithFailureCapture({
    command: 'npx',
    args: ['vitest', 'run', '--config', 'vitest.db.config.ts', ...process.argv.slice(2)],
  });
  process.exit(code);
}
