#!/usr/bin/env node
// Rehearses rollbackToLastGood()'s real subprocess sequence end-to-end (86e2v2h0e),
// without ever actually deploying: git checkout --detach, both npm ci/build steps,
// op inject, and tar all run for real via rollbackToLastGood()'s default runImpl.
// Only the final CapRover call is stubbed -- log-and-return {status: '100'} instead
// of invoking the real `caprover deploy` -- so this never overwrites the live app.
//
// The rollback path has never once completed successfully when exercised live in
// production (ENOENT on first fire, a 2h12m hang on the second, both fixed
// reactively after the fact). This is the rehearsal that would have caught both:
// triggered on demand via workflow_dispatch, never as part of the regular deploy.
//
// Exit code communicates the verdict to the CI job: 0 = the full sequence ran and
// rollbackToLastGood() reported rolledBack: true, 1 = anything else (including a
// "successful" short-circuit like a missing last-good tag -- that must FAIL this
// job, not pass it, since it means the real subprocess sequence was never exercised).

import { rollbackToLastGood } from './rollback-deploy.mjs';

/**
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {(code?: number) => void} [opts.exit]
 * @param {(msg: string) => void} [opts.logError]
 * @param {(msg: string) => void} [opts.logInfo]
 * @param {typeof rollbackToLastGood} [opts.rollbackImpl]
 */
export async function main({
  env = process.env,
  exit = process.exit,
  logError = console.error,
  logInfo = console.log,
  rollbackImpl = rollbackToLastGood,
} = {}) {
  const lastGoodTag = env.LAST_GOOD_TAG;
  const caproverUrl = env.SRC_CAPROVER_URL;
  const caproverAppToken = env.SRC_CAPROVER_APP_TOKEN;
  const caproverAppName = env.SRC_CAPROVER_APP_NAME;

  if (!lastGoodTag || !caproverUrl || !caproverAppToken || !caproverAppName) {
    logError('::error::LAST_GOOD_TAG, SRC_CAPROVER_URL, SRC_CAPROVER_APP_TOKEN, and SRC_CAPROVER_APP_NAME must all be set');
    exit(1);
    return;
  }

  // Stubbed, never the real defaultTriggerBuild -- this is the one call in the
  // sequence that would actually deploy over the live app. Logged so the job's
  // own output makes it unambiguous that no outbound CapRover API call happened.
  const stubTriggerBuild = async (url, _appToken, appName) => {
    logInfo(`[rehearsal] stubbed triggerBuild: would have deployed ${appName} via ${url} -- NOT actually invoked`);
    return { status: '100', raw: '{"status":100,"rehearsal":true}' };
  };

  let result;
  try {
    result = await rollbackImpl({
      lastGoodTag,
      caproverUrl,
      caproverAppToken,
      caproverAppName,
      triggerBuildImpl: stubTriggerBuild,
    });
  } catch (err) {
    logError(`::error::rehearsal failed: ${err.message}`);
    exit(1);
    return;
  }

  // A false here (e.g. the last-good tag doesn't exist) means the real subprocess
  // sequence never ran at all -- that must fail this job loudly, not exit 0 having
  // rehearsed nothing.
  if (result.rolledBack !== true) {
    logError(`::error::rehearsal did not complete the real sequence: ${result.reason ?? 'unknown reason'}`);
    exit(1);
    return;
  }

  logInfo(`Rehearsal complete: full rollback sequence ran for real against ${lastGoodTag} (${result.lastGoodSha}); CapRover deploy call was stubbed, not invoked.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
