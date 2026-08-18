import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { rollbackToLastGood, redactToken, main, defaultRun } from '../../scripts/rollback-deploy.mjs';

describe('rollbackToLastGood (unit)', () => {
  it('checks out the last-good SHA, rebuilds, and re-triggers CapRover with it (AC2)', async () => {
    const runImpl = vi.fn().mockResolvedValue({ stdout: 'sha-last-good\n' });
    const triggerBuildImpl = vi.fn().mockResolvedValue({ status: '100', raw: '{"status":100}' });

    const result = await rollbackToLastGood({
      lastGoodTag: 'last-good-dev',
      caproverUrl: 'captain.example.com',
      caproverAppToken: 'test-token',
      caproverAppName: 'freight-auditor-dev',
      runImpl,
      triggerBuildImpl,
    });

    expect(result).toEqual({ rolledBack: true, lastGoodSha: 'sha-last-good' });

    // proves the rollback checks out the *last-good* SHA, not some other ref
    expect(runImpl).toHaveBeenNthCalledWith(1, 'git', ['rev-parse', 'last-good-dev']);
    expect(runImpl).toHaveBeenNthCalledWith(2, 'git', ['checkout', '--detach', 'sha-last-good']);
    expect(runImpl).toHaveBeenNthCalledWith(3, 'npm', ['ci']);
    expect(runImpl).toHaveBeenNthCalledWith(4, 'npm', ['run', 'build']);

    // proves it re-invokes CapRover's trigger-build endpoint with the rebuilt last-good tarball
    expect(triggerBuildImpl).toHaveBeenCalledWith('captain.example.com', 'test-token', 'freight-auditor-dev');
  });

  it('builds the frontend too, not just the backend (86e2v1ccg)', async () => {
    const runImpl = vi.fn().mockResolvedValue({ stdout: 'sha-last-good\n' });
    const triggerBuildImpl = vi.fn().mockResolvedValue({ status: '100', raw: '{"status":100}' });

    await rollbackToLastGood({
      lastGoodTag: 'last-good-dev',
      caproverUrl: 'captain.example.com',
      caproverAppToken: 'test-token',
      caproverAppName: 'freight-auditor-dev',
      runImpl,
      triggerBuildImpl,
    });

    const calls = runImpl.mock.calls;
    expect(calls).toContainEqual(['npm', ['ci', '--prefix', 'web']]);
    expect(calls).toContainEqual(['npm', ['--prefix', 'web', 'run', 'build']]);
  });

  it('resolves the runtime .env before packaging, matching deploy.yml (86e2v1ccg / 86e2v0acm)', async () => {
    const runImpl = vi.fn().mockResolvedValue({ stdout: 'sha-last-good\n' });
    const triggerBuildImpl = vi.fn().mockResolvedValue({ status: '100', raw: '{"status":100}' });

    await rollbackToLastGood({
      lastGoodTag: 'last-good-dev',
      caproverUrl: 'captain.example.com',
      caproverAppToken: 'test-token',
      caproverAppName: 'freight-auditor-dev',
      runImpl,
      triggerBuildImpl,
    });

    const calls = runImpl.mock.calls;
    expect(calls).toContainEqual(['op', ['inject', '-i', '.env.tpl', '-o', '.env']]);

    const tarIdx = calls.findIndex(([cmd]) => cmd === 'tar');
    const injectIdx = calls.findIndex(([cmd, args]) => cmd === 'op' && (args as string[])[0] === 'inject');
    expect(injectIdx).toBeGreaterThan(-1);
    expect(tarIdx).toBeGreaterThan(injectIdx);
  });

  it('fails loudly with no last-good tag rather than rolling back to an undefined ref', async () => {
    const runImpl = vi.fn().mockRejectedValueOnce(new Error('fatal: ambiguous argument'));
    const triggerBuildImpl = vi.fn();

    const result = await rollbackToLastGood({
      lastGoodTag: 'last-good-dev',
      caproverUrl: 'captain.example.com',
      caproverAppToken: 'test-token',
      caproverAppName: 'freight-auditor-dev',
      runImpl,
      triggerBuildImpl,
    });

    expect(result).toEqual({
      rolledBack: false,
      lastGoodSha: null,
      reason: 'no last-good-dev tag exists yet',
    });
    expect(triggerBuildImpl).not.toHaveBeenCalled();
  });

  it('throws when the rollback deploy itself is rejected by CapRover', async () => {
    const runImpl = vi.fn().mockResolvedValue({ stdout: 'sha-last-good\n' });
    const triggerBuildImpl = vi.fn().mockResolvedValue({
      status: '1106',
      raw: '{"status":1106,"description":"Auth token corrupted"}',
    });

    await expect(
      rollbackToLastGood({
        lastGoodTag: 'last-good-dev',
        caproverUrl: 'captain.example.com',
        caproverAppToken: 'test-token',
        caproverAppName: 'freight-auditor-dev',
        runImpl,
        triggerBuildImpl,
      }),
    ).rejects.toThrow(/rollback deploy also failed \(status=1106\)/);
  });

  it('redacts the CapRover app token from a failed trigger-build error before it propagates (86e2t15ka AC1)', async () => {
    const secretToken = 'super-secret-caprover-token-xyz';
    const runImpl = vi.fn().mockResolvedValue({ stdout: 'sha-last-good\n' });
    const triggerBuildImpl = vi.fn().mockRejectedValue(
      new Error(
        `Command failed: curl -sS --fail-with-body -X POST https://captain.example.com/api/v2/user/apps/webhooks/triggerbuild -H "x-captain-app-token: ${secretToken}" -F sourceFile=@deploy.tar.gz`,
      ),
    );

    await expect(
      rollbackToLastGood({
        lastGoodTag: 'last-good-dev',
        caproverUrl: 'captain.example.com',
        caproverAppToken: secretToken,
        caproverAppName: 'freight-auditor-dev',
        runImpl,
        triggerBuildImpl,
      }),
    ).rejects.toThrow();

    try {
      await rollbackToLastGood({
        lastGoodTag: 'last-good-dev',
        caproverUrl: 'captain.example.com',
        caproverAppToken: secretToken,
        caproverAppName: 'freight-auditor-dev',
        runImpl,
        triggerBuildImpl,
      });
      expect.unreachable('expected rollbackToLastGood to throw');
    } catch (err) {
      expect((err as Error).message).not.toContain(secretToken);
    }
  });

  describe('rollback tarball contents (86e2tn08g)', () => {
    // Mirrors test/unit/deploy-workflow.test.ts's "ships the Dockerfile that
    // captain-definition points at" guard for the MAIN deploy step's tarball —
    // the rollback tarball is the entire Docker build context CapRover sees for a
    // rollback deploy too, so it needs the same files or the server-side build
    // fails while `caprover deploy` still exits 0 (upload success, not build success).
    function getTarCallArgs(runImpl: ReturnType<typeof vi.fn>): string[] {
      const tarCall = runImpl.mock.calls.find(([cmd]) => cmd === 'tar');
      if (!tarCall) throw new Error('expected rollbackToLastGood to run a tar command');
      return tarCall[1] as string[];
    }

    it('ships the Dockerfile that captain-definition points at (AC1/AC2)', async () => {
      const dockerfilePath = (
        JSON.parse(readFileSync(new URL('../../captain-definition', import.meta.url), 'utf8')) as {
          dockerfilePath: string;
        }
      ).dockerfilePath.replace(/^\.\//, '');

      const runImpl = vi.fn().mockResolvedValue({ stdout: 'sha-last-good\n' });
      const triggerBuildImpl = vi.fn().mockResolvedValue({ status: '100', raw: '{"status":100}' });

      await rollbackToLastGood({
        lastGoodTag: 'last-good-dev',
        caproverUrl: 'captain.example.com',
        caproverAppToken: 'test-token',
        caproverAppName: 'freight-auditor-dev',
        runImpl,
        triggerBuildImpl,
      });

      expect(getTarCallArgs(runImpl)).toContain(dockerfilePath);
    });

    it('still ships the manifests and build output the main deploy step ships (AC3)', async () => {
      const runImpl = vi.fn().mockResolvedValue({ stdout: 'sha-last-good\n' });
      const triggerBuildImpl = vi.fn().mockResolvedValue({ status: '100', raw: '{"status":100}' });

      await rollbackToLastGood({
        lastGoodTag: 'last-good-dev',
        caproverUrl: 'captain.example.com',
        caproverAppToken: 'test-token',
        caproverAppName: 'freight-auditor-dev',
        runImpl,
        triggerBuildImpl,
      });

      const tarArgs = getTarCallArgs(runImpl);
      for (const required of ['captain-definition', 'package.json', 'package-lock.json', 'dist/']) {
        expect(tarArgs).toContain(required);
      }
    });

    it('ships web/dist/ and the resolved .env, matching deploy.yml exactly (86e2v1ccg)', async () => {
      // A rollback tarball missing either of these builds a container with no
      // dashboard UI (86e2v07n3 regression) or no DATABASE_URL (86e2v0acm
      // regression) -- and caprover deploy still exits 0, so rollbackToLastGood
      // would report success while shipping something broken.
      const runImpl = vi.fn().mockResolvedValue({ stdout: 'sha-last-good\n' });
      const triggerBuildImpl = vi.fn().mockResolvedValue({ status: '100', raw: '{"status":100}' });

      await rollbackToLastGood({
        lastGoodTag: 'last-good-dev',
        caproverUrl: 'captain.example.com',
        caproverAppToken: 'test-token',
        caproverAppName: 'freight-auditor-dev',
        runImpl,
        triggerBuildImpl,
      });

      const tarArgs = getTarCallArgs(runImpl);
      expect(tarArgs).toContain('web/dist/');
      expect(tarArgs).toContain('.env');
    });
  });

  describe('defaultTriggerBuild (86e2tmq3n AC1)', () => {
    beforeEach(() => {
      vi.resetModules();
      vi.doUnmock('node:child_process');
    });

    it('invokes the caprover CLI, not the legacy webhook curl call', async () => {
      const execFile = vi.fn((_cmd, _args, _opts, cb) => cb(null, { stdout: '', stderr: '' }));
      vi.doMock('node:child_process', () => ({ execFile }));

      const { defaultTriggerBuild } = await import('../../scripts/rollback-deploy.mjs');
      const result = await defaultTriggerBuild('captain.example.com', 'test-token', 'freight-auditor-dev');

      expect(result).toEqual({ status: '100', raw: '' });
      expect(execFile).toHaveBeenCalledTimes(1);
      const [cmd, args] = execFile.mock.calls[0] as [string, string[], ...unknown[]];
      expect(cmd).toBe('caprover');
      expect(args).toEqual([
        'deploy',
        '--caproverUrl',
        'https://captain.example.com',
        '--appToken',
        'test-token',
        '--appName',
        'freight-auditor-dev',
        '--tarFile',
        'deploy.tar.gz',
      ]);
      // proves the legacy webhook path is gone, not just unused
      expect(cmd).not.toBe('curl');
      expect(args.join(' ')).not.toContain('webhooks/triggerbuild');
    });

    // 86e2v1xtf: root cause of run 31973373618's 2h12m hang. The CapRover CLI's
    // `deploy` command prompts interactively ("select the app name you want to
    // deploy to") whenever --appName/CAPROVER_APP is absent (confirmed by reading
    // caprover's own commands/deploy.js — that option has no `when: false` guard).
    // On a non-TTY CI runner that prompt never resolves: no crash, no error, no
    // output — just silence until something outside the process kills it. This
    // regression test proves the fix: the app name deploy.yml's own working step
    // already supplies is now always present in this call, so the CLI never has a
    // reason to prompt.
    it('always passes --appName so the CLI never falls back to its interactive prompt (86e2v1xtf)', async () => {
      const execFile = vi.fn((_cmd, _args, _opts, cb) => cb(null, { stdout: '', stderr: '' }));
      vi.doMock('node:child_process', () => ({ execFile }));

      const { defaultTriggerBuild } = await import('../../scripts/rollback-deploy.mjs');
      await defaultTriggerBuild('captain.example.com', 'test-token', 'freight-auditor-dev');

      const [, args] = execFile.mock.calls[0] as [string, string[], ...unknown[]];
      const appNameIdx = args.indexOf('--appName');
      expect(appNameIdx).toBeGreaterThan(-1);
      expect(args[appNameIdx + 1]).toBe('freight-auditor-dev');
    });

    // 86e2v1xtf: a bounded command-level timeout means execFile itself kills a
    // hung child and rejects, rather than relying solely on the workflow step's
    // own timeout-minutes (86e2v1qrn) to eventually tear down the whole runner.
    it('bounds the caprover CLI call with an execFile timeout (86e2v1xtf)', async () => {
      const execFile = vi.fn((_cmd, _args, _opts, cb) => cb(null, { stdout: '', stderr: '' }));
      vi.doMock('node:child_process', () => ({ execFile }));

      const { defaultTriggerBuild } = await import('../../scripts/rollback-deploy.mjs');
      await defaultTriggerBuild('captain.example.com', 'test-token', 'freight-auditor-dev');

      const [, , opts] = execFile.mock.calls[0] as [string, string[], { timeout?: number }, unknown];
      expect(opts.timeout).toBeGreaterThan(0);
    });

    it('surfaces the CLI failure status when the rollback deploy itself is rejected', async () => {
      const cliError = Object.assign(new Error('Command failed'), {
        stdout: '',
        stderr: '{"status":1106,"description":"Auth token corrupted"}',
      });
      const execFile = vi.fn((_cmd, _args, _opts, cb) => cb(cliError, undefined));
      vi.doMock('node:child_process', () => ({ execFile }));

      const { defaultTriggerBuild } = await import('../../scripts/rollback-deploy.mjs');
      const result = await defaultTriggerBuild('captain.example.com', 'test-token', 'freight-auditor-dev');

      expect(result.status).toBe('1106');
      expect(result.raw).toContain('Auth token corrupted');
    });
  });

  // 86e2v2445: defaultRun (the function that spawns git/npm/op/tar as REAL
  // subprocesses in production) appeared only in scripts/ with zero occurrences
  // under test/ before this -- every existing test injects a runImpl mock, so
  // this exact function had never been exercised by anything. These tests
  // deliberately do NOT mock node:child_process (unlike the defaultTriggerBuild
  // block above) -- vi.resetModules + vi.doUnmock here is defensive, guarding
  // against a mock leaking in from a prior test in this file rather than
  // asserting anything meaningful on its own.
  describe('defaultRun (real subprocess, no mocking) (86e2v2445)', () => {
    beforeEach(() => {
      vi.resetModules();
      vi.doUnmock('node:child_process');
    });

    it('resolves against a real, harmless command', async () => {
      const { stdout } = await defaultRun('git', ['--version']);
      expect(stdout).toMatch(/^git version/);
    });

    it('rejects when the binary does not exist, rather than hanging (ENOENT)', async () => {
      await expect(defaultRun('this-binary-does-not-exist-86e2v2445', [])).rejects.toThrow();
    });

    // This is the test that actually proves the timeout bounds a REAL hang --
    // an ENOENT above rejects instantly regardless of the timeout value, which
    // would make a naive "nonexistent binary" test pass identically whether or
    // not a timeout is wired in at all (the same shape of false-passing test
    // pg_has_role was for a different guarantee earlier this session). `sleep`
    // is a real, genuinely-blocking subprocess; passing a short timeoutMs here
    // (rather than relying on the 9-minute production default) is what makes
    // this test finish in well under a second instead of actually waiting 9
    // minutes to prove the same thing.
    it('rejects a genuinely-hanging real subprocess once its timeout elapses, rather than waiting forever', async () => {
      const start = Date.now();
      await expect(defaultRun('sleep', ['5'], 200)).rejects.toMatchObject({ killed: true });
      const elapsed = Date.now() - start;
      // Generous upper bound for CI scheduling jitter -- the point is proving
      // it resolved in ~200ms, not that `sleep 5`'s full 5000ms ever elapsed.
      expect(elapsed).toBeLessThan(4000);
    });
  });

  describe('secrets cleanup on mid-sequence failure (86e2v882v)', () => {
    // The inject->tar->cleanup sequence (op inject -> tar -czf ... .env -> rm .env)
    // previously had no try/finally: if any step in between threw, the plaintext
    // .env and the secret-laden deploy.tar.gz were left on disk with no cleanup.
    it('removes .env and deploy.tar.gz even when the tar step throws', async () => {
      const runImpl = vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === 'tar') throw new Error('tar: disk quota exceeded');
        if (cmd === 'git' && args[0] === 'rev-parse') return { stdout: 'sha-last-good\n' };
        return { stdout: '' };
      });
      const triggerBuildImpl = vi.fn();

      await expect(
        rollbackToLastGood({
          lastGoodTag: 'last-good-dev',
          caproverUrl: 'captain.example.com',
          caproverAppToken: 'test-token',
          caproverAppName: 'freight-auditor-dev',
          runImpl,
          triggerBuildImpl,
        }),
      ).rejects.toThrow(/disk quota exceeded/);

      const calls = runImpl.mock.calls;
      const rmCalls = calls.filter(([cmd]) => cmd === 'rm');
      const rmArgs = rmCalls.flatMap(([, args]) => args as string[]);
      expect(rmArgs).toContain('.env');
      expect(rmArgs).toContain('deploy.tar.gz');
      expect(triggerBuildImpl).not.toHaveBeenCalled();
    });

    it('removes .env and deploy.tar.gz even when the op inject step throws', async () => {
      const runImpl = vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === 'op') throw new Error('op: vault not found');
        if (cmd === 'git' && args[0] === 'rev-parse') return { stdout: 'sha-last-good\n' };
        return { stdout: '' };
      });
      const triggerBuildImpl = vi.fn();

      await expect(
        rollbackToLastGood({
          lastGoodTag: 'last-good-dev',
          caproverUrl: 'captain.example.com',
          caproverAppToken: 'test-token',
          caproverAppName: 'freight-auditor-dev',
          runImpl,
          triggerBuildImpl,
        }),
      ).rejects.toThrow(/vault not found/);

      const calls = runImpl.mock.calls;
      const rmCalls = calls.filter(([cmd]) => cmd === 'rm');
      const rmArgs = rmCalls.flatMap(([, args]) => args as string[]);
      // .env.tpl was already resolved to disk by this point (the write happens
      // before op inject) but .env itself was never created, so only the tarball
      // and template need cleaning up here -- proving cleanup runs regardless.
      expect(rmArgs).toContain('deploy.tar.gz');
      expect(triggerBuildImpl).not.toHaveBeenCalled();
    });

    it('still succeeds normally when nothing throws (cleanup does not become a double-remove or otherwise break the happy path)', async () => {
      const runImpl = vi.fn().mockResolvedValue({ stdout: 'sha-last-good\n' });
      const triggerBuildImpl = vi.fn().mockResolvedValue({ status: '100', raw: '{"status":100}' });

      const result = await rollbackToLastGood({
        lastGoodTag: 'last-good-dev',
        caproverUrl: 'captain.example.com',
        caproverAppToken: 'test-token',
        caproverAppName: 'freight-auditor-dev',
        runImpl,
        triggerBuildImpl,
      });

      expect(result).toEqual({ rolledBack: true, lastGoodSha: 'sha-last-good' });
      const calls = runImpl.mock.calls;
      const rmCalls = calls.filter(([cmd]) => cmd === 'rm');
      const rmArgs = rmCalls.flatMap(([, args]) => args as string[]);
      // exactly one rm('.env') and one rm('deploy.tar.gz') -- not doubled by the
      // new finally block also trying to remove what the happy path already did
      expect(rmArgs.filter((a) => a === '.env')).toHaveLength(1);
      expect(rmArgs.filter((a) => a === 'deploy.tar.gz')).toHaveLength(1);
    });

    // 86e2vpmcn: the finally block above proves cleanup happens exactly once,
    // but never proved WHEN relative to triggerBuildImpl -- and on the happy
    // path, the finally (wrapping only inject->tar) fired before line 84's
    // triggerBuildImpl call, deleting deploy.tar.gz before CapRover's CLI ever
    // reads it via --tarFile. This asserts the actual read-order guarantee: the
    // rm('deploy.tar.gz') call must come after triggerBuildImpl is invoked, not
    // before -- proven via a single shared call-order log spanning both mocks
    // (runImpl's rm calls and the separate triggerBuildImpl mock), since the two
    // are independent functions with no shared call list of their own.
    it('does not delete deploy.tar.gz until after triggerBuildImpl has read it (86e2vpmcn)', async () => {
      const order: string[] = [];
      const runImpl = vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === 'rm' && args.includes('deploy.tar.gz')) order.push('rm:deploy.tar.gz');
        if (cmd === 'git' && args[0] === 'rev-parse') return { stdout: 'sha-last-good\n' };
        return { stdout: '' };
      });
      const triggerBuildImpl = vi.fn(async () => {
        order.push('triggerBuildImpl');
        return { status: '100', raw: '{"status":100}' };
      });

      const result = await rollbackToLastGood({
        lastGoodTag: 'last-good-dev',
        caproverUrl: 'captain.example.com',
        caproverAppToken: 'test-token',
        caproverAppName: 'freight-auditor-dev',
        runImpl,
        triggerBuildImpl,
      });

      expect(result).toEqual({ rolledBack: true, lastGoodSha: 'sha-last-good' });
      const triggerIdx = order.indexOf('triggerBuildImpl');
      const rmIdx = order.indexOf('rm:deploy.tar.gz');
      expect(triggerIdx).toBeGreaterThan(-1);
      expect(rmIdx).toBeGreaterThan(-1);
      expect(rmIdx).toBeGreaterThan(triggerIdx);
    });

    it('still cleans up deploy.tar.gz and .env when triggerBuildImpl itself throws, so a rejected rollback deploy does not leave secrets on disk either (86e2vpmcn AC2)', async () => {
      const runImpl = vi.fn().mockResolvedValue({ stdout: 'sha-last-good\n' });
      const triggerBuildImpl = vi.fn().mockRejectedValue(new Error('rollback deploy also failed'));

      await expect(
        rollbackToLastGood({
          lastGoodTag: 'last-good-dev',
          caproverUrl: 'captain.example.com',
          caproverAppToken: 'test-token',
          caproverAppName: 'freight-auditor-dev',
          runImpl,
          triggerBuildImpl,
        }),
      ).rejects.toThrow(/rollback deploy also failed/);

      const calls = runImpl.mock.calls;
      const rmCalls = calls.filter(([cmd]) => cmd === 'rm');
      const rmArgs = rmCalls.flatMap(([, args]) => args as string[]);
      expect(rmArgs.filter((a) => a === '.env')).toHaveLength(1);
      expect(rmArgs.filter((a) => a === 'deploy.tar.gz')).toHaveLength(1);
    });
  });

  describe('redactToken', () => {
    it('replaces every occurrence of the token with a redaction marker', () => {
      expect(redactToken('token=abc123 seen twice: abc123', 'abc123')).toBe(
        'token=<redacted> seen twice: <redacted>',
      );
    });

    it('is a no-op when there is no token to redact', () => {
      expect(redactToken('no secrets here', undefined)).toBe('no secrets here');
    });
  });

  /**
   * Coverage-gap closure (86e2u72u2): main() (lines 103-121) — the actual rollback
   * invocation path, not just detection — had zero test coverage. Driven in-process
   * with injected env/exit/log/rollbackImpl so a mocked exit doesn't kill the runner
   * and v8 coverage sees every branch.
   */
  describe('main() (in-process, injected env/exit/log/rollbackImpl)', () => {
    const env = {
      LAST_GOOD_TAG: 'last-good-dev',
      SRC_CAPROVER_URL: 'captain.example.com',
      SRC_CAPROVER_APP_TOKEN: 'test-token',
      SRC_CAPROVER_APP_NAME: 'freight-auditor-dev',
    };

    it('exits 1 when required env vars are missing', async () => {
      const exit = vi.fn();
      const logError = vi.fn();
      await main({ env: {}, exit, logError, logInfo: vi.fn(), rollbackImpl: vi.fn() });
      expect(exit).toHaveBeenCalledWith(1);
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining(
          'LAST_GOOD_TAG, SRC_CAPROVER_URL, SRC_CAPROVER_APP_TOKEN, and SRC_CAPROVER_APP_NAME must all be set',
        ),
      );
    });

    // 86e2v1xtf: SRC_CAPROVER_APP_NAME is already resolved into this step's env by
    // deploy.yml's .env.caprover (the working "Deploy to CapRover" step reads the
    // same var) -- main() just never read it before this fix, which is exactly how
    // defaultTriggerBuild ended up invoking the CLI with no --appName. Proven as its
    // own test (not folded into the "all missing" case above) since that's the
    // specific gap this fix closes.
    it('exits 1 when only SRC_CAPROVER_APP_NAME is missing', async () => {
      const exit = vi.fn();
      const logError = vi.fn();
      const envWithoutAppName = { ...env };
      delete (envWithoutAppName as Partial<typeof env>).SRC_CAPROVER_APP_NAME;
      await main({ env: envWithoutAppName, exit, logError, logInfo: vi.fn(), rollbackImpl: vi.fn() });
      expect(exit).toHaveBeenCalledWith(1);
      expect(logError).toHaveBeenCalledWith(expect.stringContaining('SRC_CAPROVER_APP_NAME must all be set'));
    });

    it('logs success and does not exit non-zero on a successful rollback', async () => {
      const exit = vi.fn();
      const logInfo = vi.fn();
      const rollbackImpl = vi.fn().mockResolvedValue({ rolledBack: true, lastGoodSha: 'sha-last-good' });
      await main({ env, exit, logError: vi.fn(), logInfo, rollbackImpl });
      expect(rollbackImpl).toHaveBeenCalledWith({
        lastGoodTag: 'last-good-dev',
        caproverUrl: 'captain.example.com',
        caproverAppToken: 'test-token',
        caproverAppName: 'freight-auditor-dev',
      });
      expect(exit).not.toHaveBeenCalled();
      expect(logInfo).toHaveBeenCalledWith('Rolled back to last-good-dev (sha-last-good)');
    });

    it('exits 1 when the rollback reports rolledBack: false', async () => {
      const exit = vi.fn();
      const logError = vi.fn();
      const rollbackImpl = vi
        .fn()
        .mockResolvedValue({ rolledBack: false, lastGoodSha: null, reason: 'no last-good-dev tag exists yet' });
      await main({ env, exit, logError, logInfo: vi.fn(), rollbackImpl });
      expect(exit).toHaveBeenCalledWith(1);
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('no last-good-dev tag exists yet — manual recovery required'),
      );
    });

    it('exits 1 and redacts the token when rollbackImpl throws', async () => {
      const exit = vi.fn();
      const logError = vi.fn();
      const rollbackImpl = vi.fn().mockRejectedValue(new Error('deploy failed with token test-token embedded'));
      await main({ env, exit, logError, logInfo: vi.fn(), rollbackImpl });
      expect(exit).toHaveBeenCalledWith(1);
      const loggedMessage = (logError.mock.calls[0] as [string])[0];
      expect(loggedMessage).not.toContain('test-token');
      expect(loggedMessage).toContain('<redacted>');
    });
  });
});
