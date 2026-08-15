import { describe, it, expect, vi } from 'vitest';
import { isForwardProgress, advanceLastGoodTag, main } from '../../scripts/advance-last-good-tag.mjs';

/**
 * Unit coverage of advance-last-good-tag.mjs's decision logic via a mocked
 * runImpl -- no real git process. The real ancestor-check behavior against
 * actual git history is proven by test/e2e/advance-last-good-tag.e2e.test.ts,
 * which stays the source of truth for that.
 */
describe('isForwardProgress', () => {
  it('returns true immediately (no git call) when the tag does not exist yet', async () => {
    const runImpl = vi.fn();
    const result = await isForwardProgress('', 'sha-b', { runImpl });
    expect(result).toBe(true);
    expect(runImpl).not.toHaveBeenCalled();
  });

  it('uses the real default spawn-based runImpl when none is injected (86e2u72u2: exercise the real subprocess path, not just the mock)', async () => {
    // Real git, read-only (merge-base --is-ancestor never mutates), against
    // this repo's own history -- HEAD is trivially an ancestor of itself.
    const { stdout } = await import('node:child_process').then(({ execSync }) => ({
      stdout: execSync('git rev-parse HEAD').toString().trim(),
    }));
    const result = await isForwardProgress(stdout, stdout);
    expect(result).toBe(true);
  });

  it('returns true when merge-base --is-ancestor exits 0 (target is a descendant)', async () => {
    const runImpl = vi.fn().mockResolvedValue({ code: 0 });
    const result = await isForwardProgress('sha-a', 'sha-b', { runImpl });
    expect(result).toBe(true);
    expect(runImpl).toHaveBeenCalledWith('git', ['merge-base', '--is-ancestor', 'sha-a', 'sha-b']);
  });

  it('returns false when merge-base --is-ancestor exits nonzero (not a descendant)', async () => {
    const runImpl = vi.fn().mockResolvedValue({ code: 1 });
    const result = await isForwardProgress('sha-a', 'sha-b', { runImpl });
    expect(result).toBe(false);
  });
});

describe('advanceLastGoodTag', () => {
  it('advances the tag and pushes when the target is forward progress', async () => {
    const runImpl = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: 'sha-a\n' }) // rev-parse current tag
      .mockResolvedValueOnce({ code: 0 }) // merge-base --is-ancestor
      .mockResolvedValueOnce({ code: 0 }) // tag -f
      .mockResolvedValueOnce({ code: 0 }); // push

    const result = await advanceLastGoodTag({ lastGoodTag: 'last-good-dev', targetSha: 'sha-b', runImpl });

    expect(result).toEqual({ advanced: true });
    expect(runImpl).toHaveBeenNthCalledWith(3, 'git', ['tag', '-f', 'last-good-dev', 'sha-b']);
    expect(runImpl).toHaveBeenNthCalledWith(4, 'git', ['push', 'origin', 'last-good-dev', '--force']);
  });

  it('skips the tag/push entirely when the target is not forward progress', async () => {
    const runImpl = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: 'sha-b\n' }) // current tag already at sha-b
      .mockResolvedValueOnce({ code: 1 }); // sha-a is NOT a descendant of sha-b

    const result = await advanceLastGoodTag({ lastGoodTag: 'last-good-dev', targetSha: 'sha-a', runImpl });

    expect(result).toEqual({ advanced: false, reason: 'not-forward-progress' });
    expect(runImpl).toHaveBeenCalledTimes(2); // never reaches tag/push
  });

  it('treats a nonexistent tag (rev-parse fails) as no current position, not an error', async () => {
    const runImpl = vi
      .fn()
      .mockResolvedValueOnce({ code: 1, stdout: '' }) // rev-parse fails: no tag yet
      .mockResolvedValueOnce({ code: 0 }) // tag -f
      .mockResolvedValueOnce({ code: 0 }); // push

    const result = await advanceLastGoodTag({ lastGoodTag: 'last-good-dev', targetSha: 'sha-a', runImpl });
    expect(result).toEqual({ advanced: true });
  });

  it('throws when git tag -f fails', async () => {
    const runImpl = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: 'sha-a\n' })
      .mockResolvedValueOnce({ code: 0 }) // is-ancestor: forward progress
      .mockResolvedValueOnce({ code: 1 }); // tag -f fails
    await expect(
      advanceLastGoodTag({ lastGoodTag: 'last-good-dev', targetSha: 'sha-b', runImpl }),
    ).rejects.toThrow(/git tag -f/);
  });

  it('throws when git push fails', async () => {
    const runImpl = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: 'sha-a\n' })
      .mockResolvedValueOnce({ code: 0 })
      .mockResolvedValueOnce({ code: 0 }) // tag -f succeeds
      .mockResolvedValueOnce({ code: 1 }); // push fails
    await expect(
      advanceLastGoodTag({ lastGoodTag: 'last-good-dev', targetSha: 'sha-b', runImpl }),
    ).rejects.toThrow(/git push/);
  });
});

describe('main() (in-process, injected env/exit/advanceImpl)', () => {
  it('reads LAST_GOOD_TAG and GITHUB_SHA from env and calls advanceImpl', async () => {
    const advanceImpl = vi.fn().mockResolvedValue({ advanced: true });
    const exit = vi.fn();
    await main({ env: { LAST_GOOD_TAG: 'last-good-dev', GITHUB_SHA: 'sha-x' }, exit, advanceImpl });
    expect(advanceImpl).toHaveBeenCalledWith({ lastGoodTag: 'last-good-dev', targetSha: 'sha-x' });
    expect(exit).not.toHaveBeenCalled();
  });

  it('exits 1 with an error when LAST_GOOD_TAG or GITHUB_SHA is missing', async () => {
    const logError = vi.fn();
    const exit = vi.fn();
    const advanceImpl = vi.fn();
    await main({ env: {}, exit, advanceImpl, logError });
    expect(exit).toHaveBeenCalledWith(1);
    expect(advanceImpl).not.toHaveBeenCalled();
  });
});
