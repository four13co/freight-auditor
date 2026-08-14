import { describe, it, expect, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractHost, isProtectedHost, main, PROTECTED_DB_HOSTS } from '../../scripts/guard-protected-db.mjs';

const run = promisify(execFile);
const SCRIPT = new URL('../../scripts/guard-protected-db.mjs', import.meta.url);

describe('guard-protected-db (unit)', () => {
  describe('extractHost', () => {
    it('extracts the hostname from a postgres connection URL', () => {
      expect(extractHost('postgresql://user:pw@127.0.0.1:5432/db')).toBe('127.0.0.1');
    });

    it('throws when the URL cannot be parsed', () => {
      expect(() => extractHost('not-a-url')).toThrow(/Could not parse DATABASE_URL/);
    });

    it('does not leak the raw connection string (with embedded password) in the thrown message (86e2t15ka AC2)', () => {
      const malformedUrlWithPassword = 'not a valid url but has a secretpassword123 in it';
      try {
        extractHost(malformedUrlWithPassword);
        expect.unreachable('expected extractHost to throw');
      } catch (err) {
        expect((err as Error).message).not.toContain('secretpassword123');
        expect((err as Error).message).not.toContain(malformedUrlWithPassword);
      }
    });
  });

  describe('isProtectedHost', () => {
    it.each(PROTECTED_DB_HOSTS as string[])('rejects %s as a protected host', (host: string) => {
      expect(isProtectedHost(host)).toBe(true);
    });

    it('rejects a subdomain of a protected host', () => {
      expect(isProtectedHost('ep-cool-name-123.us-east-2.aws.neon.tech')).toBe(true);
    });

    it('passes the actual CapRover-hosted DB host', () => {
      expect(isProtectedHost('srv-captain--freight-auditor-db')).toBe(false);
    });

    it('passes a local ephemeral host', () => {
      expect(isProtectedHost('127.0.0.1')).toBe(false);
    });
  });

  /**
   * Coverage-gap closure (86e2u72u2): main() (lines 22-44) was previously exercised
   * only by the e2e migrate-database job, which is skipIf(!DATABASE_URL) and never
   * runs in the default CI suite. These drive main() in-process with injected
   * env/exit/log (so v8 coverage sees it and a mocked exit doesn't kill the test
   * runner) — the piece two prior CI incidents actually broke on.
   */
  describe('main() (in-process, injected env/exit/log)', () => {
    it('exits 1 with an error when DATABASE_URL is not set', () => {
      const exit = vi.fn();
      const logError = vi.fn();
      main({ env: {}, exit, logError, logInfo: vi.fn() });
      expect(exit).toHaveBeenCalledWith(1);
      expect(logError).toHaveBeenCalledWith(expect.stringContaining('DATABASE_URL is not set'));
    });

    it('exits 1 with an error when DATABASE_URL cannot be parsed', () => {
      const exit = vi.fn();
      const logError = vi.fn();
      main({ env: { DATABASE_URL: 'not-a-url' }, exit, logError, logInfo: vi.fn() });
      expect(exit).toHaveBeenCalledWith(1);
      expect(logError).toHaveBeenCalledWith(expect.stringContaining('Could not parse DATABASE_URL'));
    });

    it('exits 1 and refuses a protected host', () => {
      const exit = vi.fn();
      const logError = vi.fn();
      main({
        env: { DATABASE_URL: 'postgresql://user:pw@ep-cool.us-east-2.aws.neon.tech/db' },
        exit,
        logError,
        logInfo: vi.fn(),
      });
      expect(exit).toHaveBeenCalledWith(1);
      expect(logError).toHaveBeenCalledWith(expect.stringContaining('Refusing to run against protected host'));
    });

    it('proceeds past a protected host when ALLOW_PROTECTED_DB_HOST=1 is set', () => {
      const exit = vi.fn();
      const logInfo = vi.fn();
      main({
        env: {
          DATABASE_URL: 'postgresql://user:pw@ep-cool.us-east-2.aws.neon.tech/db',
          ALLOW_PROTECTED_DB_HOST: '1',
        },
        exit,
        logError: vi.fn(),
        logInfo,
      });
      expect(exit).not.toHaveBeenCalled();
      expect(logInfo).toHaveBeenCalledWith(expect.stringContaining('is not protected — proceeding'));
    });

    it('proceeds normally for a non-protected host', () => {
      const exit = vi.fn();
      const logInfo = vi.fn();
      main({ env: { DATABASE_URL: 'postgresql://user:pw@127.0.0.1:5432/db' }, exit, logError: vi.fn(), logInfo });
      expect(exit).not.toHaveBeenCalled();
      expect(logInfo).toHaveBeenCalledWith('DATABASE_URL host "127.0.0.1" is not protected — proceeding.');
    });
  });

  /**
   * Kept alongside the in-process tests above: this is the only proof the actual
   * CLI entrypoint (env var wiring, real process.exit code, stderr/stdout) works
   * end-to-end, not just the factored-out main() function.
   */
  describe('CLI entrypoint (subprocess, no DB required)', () => {
    it('exits 1 with an error when DATABASE_URL is not set', async () => {
      const env = { ...process.env };
      delete env.DATABASE_URL;
      await expect(run('node', [SCRIPT.pathname], { env })).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('DATABASE_URL is not set'),
      });
    });

    it('exits 1 with an error when DATABASE_URL cannot be parsed', async () => {
      await expect(
        run('node', [SCRIPT.pathname], { env: { ...process.env, DATABASE_URL: 'not-a-url' } }),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('Could not parse DATABASE_URL'),
      });
    });

    it('exits 1 and refuses a protected host', async () => {
      await expect(
        run('node', [SCRIPT.pathname], {
          env: {
            ...process.env,
            DATABASE_URL: 'postgresql://user:pw@ep-cool.us-east-2.aws.neon.tech/db',
          },
        }),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('Refusing to run against protected host'),
      });
    });

    it('proceeds past a protected host when ALLOW_PROTECTED_DB_HOST=1 is set', async () => {
      const { stdout } = await run('node', [SCRIPT.pathname], {
        env: {
          ...process.env,
          DATABASE_URL: 'postgresql://user:pw@ep-cool.us-east-2.aws.neon.tech/db',
          ALLOW_PROTECTED_DB_HOST: '1',
        },
      });
      expect(stdout).toContain('is not protected — proceeding');
    });

    it('proceeds normally for a non-protected host', async () => {
      const { stdout } = await run('node', [SCRIPT.pathname], {
        env: { ...process.env, DATABASE_URL: 'postgresql://user:pw@127.0.0.1:5432/db' },
      });
      expect(stdout).toContain('DATABASE_URL host "127.0.0.1" is not protected — proceeding.');
    });
  });
});
