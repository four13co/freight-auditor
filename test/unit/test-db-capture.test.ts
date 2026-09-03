import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithFailureCapture } from '../../scripts/test-db-capture.mjs';

/**
 * In-process tests driving the factored-out function directly (fast, no
 * real vitest/DB run, v8 coverage sees it) -- see the note at the bottom of
 * this file for why there's no separate CLI-entrypoint subprocess test.
 */
describe('test-db-capture (unit)', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempFailureDir() {
    const dir = mkdtempSync(join(tmpdir(), 'test-db-capture-'));
    tempDirs.push(dir);
    return dir;
  }

  describe('runWithFailureCapture', () => {
    it('86e33t7yu AC (process fix): a failing command has its full combined stdout+stderr captured to a file, and the file path is returned', async () => {
      const failureDir = tempFailureDir();
      const { code, capturedTo } = await runWithFailureCapture({
        command: 'node',
        args: ['-e', "console.log('seed row count: 0'); console.error('AssertionError: expected 1 row'); process.exit(1);"],
        failureDir,
        now: () => '2026-09-03T10-00-00-000Z',
      });

      expect(code).toBe(1);
      expect(capturedTo).not.toBeNull();
      const content = readFileSync(capturedTo!, 'utf8');
      expect(content).toContain('seed row count: 0');
      expect(content).toContain('AssertionError: expected 1 row');
    });

    it('does not write a capture file on success (passthrough, no side effect on the happy path)', async () => {
      const failureDir = tempFailureDir();
      const { code, capturedTo } = await runWithFailureCapture({
        command: 'node',
        args: ['-e', "console.log('all good'); process.exit(0);"],
        failureDir,
      });

      expect(code).toBe(0);
      expect(capturedTo).toBeNull();
      expect(() => readdirSync(failureDir)).not.toThrow();
      expect(readdirSync(failureDir)).toHaveLength(0);
    });

    it('creates the failure directory if it does not exist yet', async () => {
      const parent = tempFailureDir();
      const failureDir = join(parent, 'nested', 'does-not-exist-yet');
      const { capturedTo } = await runWithFailureCapture({
        command: 'node',
        args: ['-e', 'process.exit(1);'],
        failureDir,
      });
      expect(capturedTo).toContain(failureDir);
      expect(readdirSync(failureDir)).toHaveLength(1);
    });

    it('names the capture file uniquely per failure (two failures in the same dir do not collide)', async () => {
      const failureDir = tempFailureDir();
      const first = await runWithFailureCapture({
        command: 'node',
        args: ['-e', "console.log('first'); process.exit(1);"],
        failureDir,
        now: () => '2026-09-03T10-00-00-000Z',
      });
      const second = await runWithFailureCapture({
        command: 'node',
        args: ['-e', "console.log('second'); process.exit(1);"],
        failureDir,
        now: () => '2026-09-03T10-00-01-000Z',
      });

      expect(first.capturedTo).not.toBe(second.capturedTo);
      expect(readFileSync(first.capturedTo!, 'utf8')).toContain('first');
      expect(readFileSync(second.capturedTo!, 'utf8')).toContain('second');
    });
  });

  // No CLI-entrypoint subprocess test here (unlike guard-protected-db.test.ts's
  // own CLI block): this script's top-level guard is trivial glue with no
  // branching logic of its own (it always shells to the same fixed `npx
  // vitest run --config vitest.db.config.ts` command) -- the real coverage
  // gap that pattern exists to close is branching CLI logic, which
  // runWithFailureCapture's own tests above already fully exercise. Actually
  // invoking the real vitest command here would require a reachable DB (or
  // accept vitest's own unpredictable-across-versions failure mode without
  // one), which is a worse trade than the marginal wiring coverage buys.
});
