#!/usr/bin/env node
// Advances the last-good-<env> tag to the deployed commit, but ONLY if that
// commit is actually a descendant of the tag's current position (86e2urk0k).
//
// deploy.yml's post-deployment runs are NOT serialized against each other
// beyond the concurrency: group added alongside this script -- a
// concurrency group prevents runs from OVERLAPPING, but GitHub's own queue
// does not guarantee they fire in commit order. A run for an older commit
// can still execute after a newer commit's run already advanced the tag.
// Observed 2026-08-15: PRs #51-#54 merged ~20s apart; PR #53's run (an
// ancestor commit in the real merge order) finished AFTER PR #51's had
// already moved last-good-dev forward, and tried to force it back -- which
// happened to fail loudly only because that specific backward diff touched
// a protected workflow file. The underlying race is silent on any commit
// pair that doesn't happen to touch one.
//
// This is belt-and-suspenders alongside the concurrency group, not a
// replacement for it: even serialized, nothing guarantees queue order
// matches commit order. The ancestor check is what actually prevents the
// tag from ever moving backward, regardless of run ordering.
//
// Do NOT "fix" this by granting the deploy token `workflows` permission --
// that removes the loud failure without removing the race, turning a
// visible bug into a silent one.

/**
 * @param {string} currentTagSha - the last-good tag's current commit (empty string if the tag doesn't exist yet)
 * @param {string} targetSha - the commit this run wants to advance the tag to
 * @param {object} [opts]
 * @param {(cmd: string, args: string[]) => Promise<{ code: number }>} [opts.runImpl] - injectable for tests; must resolve with the exit code, never reject on a nonzero one (that's the ancestor check's own signal, not a real failure)
 * @returns {Promise<boolean>} true if targetSha is a descendant of currentTagSha (forward progress; safe to advance)
 */
export async function isForwardProgress(currentTagSha, targetSha, { runImpl = defaultRun } = {}) {
  if (!currentTagSha) return true; // tag doesn't exist yet -- nothing to move backward past
  const { code } = await runImpl('git', ['merge-base', '--is-ancestor', currentTagSha, targetSha]);
  return code === 0;
}

/**
 * @param {object} opts
 * @param {string} opts.lastGoodTag - e.g. "last-good-dev"
 * @param {string} opts.targetSha - the commit to advance the tag to (github.sha)
 * @param {(cmd: string, args: string[]) => Promise<{ code: number, stdout?: string }>} [opts.runImpl] - injectable for tests
 * @param {(msg: string) => void} [opts.logInfo]
 * @returns {Promise<{ advanced: boolean, reason?: string }>}
 */
export async function advanceLastGoodTag({ lastGoodTag, targetSha, runImpl = defaultRun, logInfo = console.log }) {
  const revParse = await runImpl('git', ['rev-parse', `refs/tags/${lastGoodTag}`]);
  const currentTagSha = revParse.code === 0 ? (revParse.stdout ?? '').trim() : '';

  const forward = await isForwardProgress(currentTagSha, targetSha, { runImpl });
  if (!forward) {
    logInfo(
      `Skipping ${lastGoodTag} advance: ${targetSha} is not a descendant of its current position ` +
        `(${currentTagSha || '<no tag yet>'}) -- another run already moved it forward. Not moving it backward.`,
    );
    return { advanced: false, reason: 'not-forward-progress' };
  }

  const tagResult = await runImpl('git', ['tag', '-f', lastGoodTag, targetSha]);
  if (tagResult.code !== 0) {
    throw new Error(`git tag -f ${lastGoodTag} ${targetSha} failed (exit ${tagResult.code})`);
  }
  const pushResult = await runImpl('git', ['push', 'origin', lastGoodTag, '--force']);
  if (pushResult.code !== 0) {
    throw new Error(`git push origin ${lastGoodTag} --force failed (exit ${pushResult.code})`);
  }
  logInfo(`Advanced ${lastGoodTag} to ${targetSha}`);
  return { advanced: true };
}

function defaultRun(cmd, args) {
  return new Promise((resolve, reject) => {
    // Real subprocess wiring only reached outside tests -- kept minimal
    // (node:child_process.spawn) so it never diverges from what tests
    // inject via runImpl.
    import('node:child_process').then(({ spawn }) => {
      const child = spawn(cmd, args);
      let stdout = '';
      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
    });
  });
}

/**
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {(code?: number) => void} [opts.exit]
 * @param {typeof advanceLastGoodTag} [opts.advanceImpl]
 * @param {(msg: string) => void} [opts.logError]
 */
export async function main({ env = process.env, exit = process.exit, advanceImpl = advanceLastGoodTag, logError = console.error } = {}) {
  const lastGoodTag = env.LAST_GOOD_TAG;
  const targetSha = env.GITHUB_SHA;
  if (!lastGoodTag || !targetSha) {
    logError('::error::LAST_GOOD_TAG and GITHUB_SHA must both be set');
    exit(1);
    return;
  }
  await advanceImpl({ lastGoodTag, targetSha });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
