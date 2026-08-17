import { describe, it, expect, vi } from 'vitest';
import { main } from '../../scripts/rollback-rehearsal.mjs';

// 86e2v2h0e: the rehearsal driver's OWN logic (env validation, exit codes, the
// rolledBack === true gate) is tested here with an injected rollbackImpl, exactly
// like rollback-deploy.test.ts's main() suite -- these tests do not exercise real
// subprocesses (that's the workflow's job when actually dispatched; see
// rollback-rehearsal.test.ts's sibling coverage in deploy-workflow-style tests for
// the workflow file itself, and the item's own AC for what "real" means live).
describe('rollback rehearsal main() (in-process, injected env/exit/log/rollbackImpl)', () => {
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

  it('passes a stubbed triggerBuildImpl to rollbackImpl -- never the real one', async () => {
    const rollbackImpl = vi.fn().mockResolvedValue({ rolledBack: true, lastGoodSha: 'sha-last-good' });
    await main({ env, exit: vi.fn(), logError: vi.fn(), logInfo: vi.fn(), rollbackImpl });

    expect(rollbackImpl).toHaveBeenCalledTimes(1);
    const callArgs = rollbackImpl.mock.calls[0]![0];
    expect(callArgs).toMatchObject({
      lastGoodTag: 'last-good-dev',
      caproverUrl: 'captain.example.com',
      caproverAppToken: 'test-token',
      caproverAppName: 'freight-auditor-dev',
    });
    expect(typeof callArgs.triggerBuildImpl).toBe('function');
  });

  it('the stubbed triggerBuildImpl logs instead of invoking the real CapRover call, and returns a rehearsal-tagged success', async () => {
    const rollbackImpl = vi.fn().mockResolvedValue({ rolledBack: true, lastGoodSha: 'sha-last-good' });
    const logInfo = vi.fn();
    await main({ env, exit: vi.fn(), logError: vi.fn(), logInfo, rollbackImpl });

    const stubTriggerBuild = rollbackImpl.mock.calls[0]![0].triggerBuildImpl;
    const result = await stubTriggerBuild('captain.example.com', 'test-token', 'freight-auditor-dev');

    expect(result).toEqual({ status: '100', raw: '{"status":100,"rehearsal":true}' });
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining('stubbed triggerBuild'));
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining('NOT actually invoked'));
  });

  it('logs success and does not exit non-zero when rolledBack is true', async () => {
    const exit = vi.fn();
    const logInfo = vi.fn();
    const rollbackImpl = vi.fn().mockResolvedValue({ rolledBack: true, lastGoodSha: 'sha-last-good' });
    await main({ env, exit, logError: vi.fn(), logInfo, rollbackImpl });
    expect(exit).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining('Rehearsal complete'));
  });

  // AC: "a run where rollbackToLastGood short-circuits with {rolledBack: false}
  // (e.g. tag lookup fails) must FAIL the job, not pass it" -- job exit code 0
  // alone is not proof the real sequence ran; this is the explicit gate.
  it('exits 1 when rollbackImpl reports rolledBack: false, even though it did not throw', async () => {
    const exit = vi.fn();
    const logError = vi.fn();
    const rollbackImpl = vi
      .fn()
      .mockResolvedValue({ rolledBack: false, lastGoodSha: null, reason: 'no last-good-dev tag exists yet' });
    await main({ env, exit, logError, logInfo: vi.fn(), rollbackImpl });
    expect(exit).toHaveBeenCalledWith(1);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('no last-good-dev tag exists yet'));
  });

  it('exits 1 when rollbackImpl throws', async () => {
    const exit = vi.fn();
    const logError = vi.fn();
    const rollbackImpl = vi.fn().mockRejectedValue(new Error('git checkout failed'));
    await main({ env, exit, logError, logInfo: vi.fn(), rollbackImpl });
    expect(exit).toHaveBeenCalledWith(1);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('git checkout failed'));
  });
});
