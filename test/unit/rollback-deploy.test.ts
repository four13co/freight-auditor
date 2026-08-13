import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rollbackToLastGood, redactToken } from '../../scripts/rollback-deploy.mjs';

describe('rollbackToLastGood (unit)', () => {
  it('checks out the last-good SHA, rebuilds, and re-triggers CapRover with it (AC2)', async () => {
    const runImpl = vi
      .fn()
      // git rev-parse last-good-dev
      .mockResolvedValueOnce({ stdout: 'sha-last-good\n' })
      // git checkout --detach sha-last-good
      .mockResolvedValueOnce({ stdout: '' })
      // npm ci
      .mockResolvedValueOnce({ stdout: '' })
      // npm run build
      .mockResolvedValueOnce({ stdout: '' })
      // write BUILD_SHA
      .mockResolvedValueOnce({ stdout: '' })
      // tar
      .mockResolvedValueOnce({ stdout: '' });
    const triggerBuildImpl = vi.fn().mockResolvedValue({ status: '100', raw: '{"status":100}' });

    const result = await rollbackToLastGood({
      lastGoodTag: 'last-good-dev',
      caproverUrl: 'captain.example.com',
      caproverAppToken: 'test-token',
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
    expect(triggerBuildImpl).toHaveBeenCalledWith('captain.example.com', 'test-token');
  });

  it('fails loudly with no last-good tag rather than rolling back to an undefined ref', async () => {
    const runImpl = vi.fn().mockRejectedValueOnce(new Error('fatal: ambiguous argument'));
    const triggerBuildImpl = vi.fn();

    const result = await rollbackToLastGood({
      lastGoodTag: 'last-good-dev',
      caproverUrl: 'captain.example.com',
      caproverAppToken: 'test-token',
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
        runImpl,
        triggerBuildImpl,
      }),
    ).rejects.toThrow();

    try {
      await rollbackToLastGood({
        lastGoodTag: 'last-good-dev',
        caproverUrl: 'captain.example.com',
        caproverAppToken: secretToken,
        runImpl,
        triggerBuildImpl,
      });
      expect.unreachable('expected rollbackToLastGood to throw');
    } catch (err) {
      expect((err as Error).message).not.toContain(secretToken);
    }
  });

  describe('defaultTriggerBuild (86e2tmq3n AC1)', () => {
    beforeEach(() => {
      vi.resetModules();
      vi.doUnmock('node:child_process');
    });

    it('invokes the caprover CLI, not the legacy webhook curl call', async () => {
      const execFile = vi.fn((_cmd, _args, cb) => cb(null, { stdout: '', stderr: '' }));
      vi.doMock('node:child_process', () => ({ execFile }));

      const { defaultTriggerBuild } = await import('../../scripts/rollback-deploy.mjs');
      const result = await defaultTriggerBuild('captain.example.com', 'test-token');

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
        '--tarFile',
        'deploy.tar.gz',
      ]);
      // proves the legacy webhook path is gone, not just unused
      expect(cmd).not.toBe('curl');
      expect(args.join(' ')).not.toContain('webhooks/triggerbuild');
    });

    it('surfaces the CLI failure status when the rollback deploy itself is rejected', async () => {
      const cliError = Object.assign(new Error('Command failed'), {
        stdout: '',
        stderr: '{"status":1106,"description":"Auth token corrupted"}',
      });
      const execFile = vi.fn((_cmd, _args, cb) => cb(cliError, undefined));
      vi.doMock('node:child_process', () => ({ execFile }));

      const { defaultTriggerBuild } = await import('../../scripts/rollback-deploy.mjs');
      const result = await defaultTriggerBuild('captain.example.com', 'test-token');

      expect(result.status).toBe('1106');
      expect(result.raw).toContain('Auth token corrupted');
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
});
