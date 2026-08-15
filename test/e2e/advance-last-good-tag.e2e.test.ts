import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advanceLastGoodTag } from '../../scripts/advance-last-good-tag.mjs';

const run = promisify(execFile);

/**
 * 86e2urk0k ACs, against a REAL ephemeral git repo (not a mocked runImpl) --
 * `git merge-base --is-ancestor` has to run against actual history for this
 * to prove anything. Simulates both completion orderings the real incident
 * hit: an older commit's post-deployment run finishing AFTER a newer
 * commit's already advanced the tag.
 */
describe('advanceLastGoodTag (e2e, real git repo)', () => {
  let repoDir: string;
  let originDir: string;
  let shaA: string; // older commit
  let shaB: string; // newer commit, descendant of A

  async function git(args: string[]) {
    return run('git', args, { cwd: repoDir });
  }

  function runImpl(cmd: string, args: string[]) {
    return run(cmd, args, { cwd: repoDir }).then(
      (result) => ({ code: 0, stdout: result.stdout }),
      (err: { code?: number; stdout?: string }) => ({ code: err.code ?? 1, stdout: err.stdout ?? '' }),
    );
  }

  beforeEach(async () => {
    // A real bare "origin" so `git push origin <tag> --force` (the actual
    // step being tested, not just the ancestor-check logic) has something
    // real to push to -- without this, the push fails with no remote and
    // advanceLastGoodTag throws, masking whether the ancestor check itself
    // is correct.
    originDir = await mkdtemp(join(tmpdir(), 'fa-lastgood-origin-'));
    await run('git', ['init', '--bare', '-q'], { cwd: originDir });

    repoDir = await mkdtemp(join(tmpdir(), 'fa-lastgood-'));
    await git(['init', '-q']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test']);
    await git(['remote', 'add', 'origin', originDir]);
    await git(['commit', '--allow-empty', '-m', 'commit A', '-q']);
    shaA = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    await git(['commit', '--allow-empty', '-m', 'commit B', '-q']);
    shaB = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(originDir, { recursive: true, force: true });
  });

  it('AC1 (in-order): tag advances to A, then to B -- ends at B', async () => {
    const first = await advanceLastGoodTag({ lastGoodTag: 'last-good-dev', targetSha: shaA, runImpl });
    expect(first.advanced).toBe(true);
    const second = await advanceLastGoodTag({ lastGoodTag: 'last-good-dev', targetSha: shaB, runImpl });
    expect(second.advanced).toBe(true);

    const finalSha = (await git(['rev-parse', 'refs/tags/last-good-dev'])).stdout.trim();
    expect(finalSha).toBe(shaB);
  });

  it('AC1/AC2 (out-of-order -- the actual incident): B advances the tag first, then A\'s run tries to advance it after -- tag stays at B, never regresses to A', async () => {
    const first = await advanceLastGoodTag({ lastGoodTag: 'last-good-dev', targetSha: shaB, runImpl });
    expect(first.advanced).toBe(true);

    const second = await advanceLastGoodTag({ lastGoodTag: 'last-good-dev', targetSha: shaA, runImpl });
    expect(second.advanced).toBe(false);
    expect(second.reason).toBe('not-forward-progress');

    const finalSha = (await git(['rev-parse', 'refs/tags/last-good-dev'])).stdout.trim();
    expect(finalSha).toBe(shaB); // never regressed
  });

  it('advances cleanly when the tag does not exist yet (first-ever deploy)', async () => {
    const result = await advanceLastGoodTag({ lastGoodTag: 'last-good-dev', targetSha: shaA, runImpl });
    expect(result.advanced).toBe(true);
    const finalSha = (await git(['rev-parse', 'refs/tags/last-good-dev'])).stdout.trim();
    expect(finalSha).toBe(shaA);
  });

  it('throws (does not silently succeed) when the push to origin actually fails', async () => {
    // Point origin somewhere that can't accept a push, so the real push
    // step fails and this asserts advanceLastGoodTag surfaces that rather
    // than reporting success anyway.
    await git(['remote', 'set-url', 'origin', '/nonexistent/path']);
    await expect(
      advanceLastGoodTag({ lastGoodTag: 'last-good-dev', targetSha: shaA, runImpl }),
    ).rejects.toThrow(/push/);
  });
});
