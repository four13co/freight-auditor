#!/usr/bin/env node
// Rolls back a failed deploy to the last known-good revision: checks out the
// last-good tag, rebuilds, and re-triggers CapRover with that build. Exit code
// communicates the verdict to the CI job: 0 = rollback deploy accepted,
// 1 = no last-good tag exists yet, or the rollback deploy itself failed.

/**
 * @param {object} opts
 * @param {string} opts.lastGoodTag - e.g. "last-good-dev"
 * @param {string} opts.caproverUrl
 * @param {string} opts.caproverAppToken
 * @param {(cmd: string, args: string[]) => Promise<{ stdout: string }>} [opts.runImpl] - injectable for tests
 * @param {(url: string, appToken: string) => Promise<{ status: string; raw: string }>} [opts.triggerBuildImpl] - injectable for tests
 * @returns {Promise<{ rolledBack: boolean, lastGoodSha: string | null, reason?: string }>}
 */
export async function rollbackToLastGood({
  lastGoodTag,
  caproverUrl,
  caproverAppToken,
  runImpl = defaultRun,
  triggerBuildImpl = defaultTriggerBuild,
}) {
  let lastGoodSha;
  try {
    const { stdout } = await runImpl('git', ['rev-parse', lastGoodTag]);
    lastGoodSha = stdout.trim();
  } catch {
    return { rolledBack: false, lastGoodSha: null, reason: `no ${lastGoodTag} tag exists yet` };
  }

  await runImpl('git', ['checkout', '--detach', lastGoodSha]);
  await runImpl('npm', ['ci']);
  await runImpl('npm', ['run', 'build']);
  await runImpl('node', ['-e', `require('fs').writeFileSync('dist/server/BUILD_SHA', '${lastGoodSha}')`]);
  // Must match .github/workflows/deploy.yml's "Create deployment tarball" file list —
  // the tarball IS the entire Docker build context CapRover sees, and captain-definition
  // points at "./Dockerfile", so omitting it here fails the rollback's server-side build
  // exactly like PR #33 fixed for the main deploy step (86e2tn08g).
  await runImpl('tar', [
    '-czf',
    'deploy.tar.gz',
    'Dockerfile',
    'captain-definition',
    'package.json',
    'package-lock.json',
    'dist/',
  ]);

  let result;
  try {
    result = await triggerBuildImpl(caproverUrl, caproverAppToken);
  } catch (err) {
    throw new Error(redactToken(err.message, caproverAppToken));
  }
  if (result.status !== '100') {
    throw new Error(redactToken(`rollback deploy also failed (status=${result.status}): ${result.raw}`, caproverAppToken));
  }

  return { rolledBack: true, lastGoodSha };
}

async function defaultRun(cmd, args) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  return promisify(execFile)(cmd, args);
}

// Uses the same `caprover deploy` CLI path PR #27 already moved the main deploy step to
// (.github/workflows/deploy.yml "Deploy to CapRover"), instead of the legacy
// `/api/v2/user/apps/webhooks/triggerbuild` webhook this previously hand-rolled via curl.
// That webhook is the same endpoint 86e25prau and 86e25uqxa both chased "Auth token
// corrupted" (status 1106) failures on for the main deploy step — rollback shared the
// defect only because it never got the CLI fix applied alongside it.
export async function defaultTriggerBuild(caproverUrl, caproverAppToken) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    const { stdout } = await run('caprover', [
      'deploy',
      '--caproverUrl',
      `https://${caproverUrl}`,
      '--appToken',
      caproverAppToken,
      '--tarFile',
      'deploy.tar.gz',
    ]);
    return { status: '100', raw: stdout };
  } catch (err) {
    // The CLI exits non-zero and reports the failure on stdout/stderr rather than
    // throwing a structured error, so surface whatever it printed as `raw`.
    const raw = [err.stdout, err.stderr].filter(Boolean).join('\n') || err.message;
    const statusMatch = raw.match(/"status"\s*:\s*(\d+)/);
    return { status: statusMatch ? statusMatch[1] : 'cli-error', raw };
  }
}

export function redactToken(message, token) {
  return token ? message.split(token).join('<redacted>') : message;
}

/**
 * The CLI body, factored out so tests can drive it in-process (injectable env/exit/log/
 * rollbackImpl) instead of only via a subprocess — a subprocess call is invisible to v8
 * coverage instrumentation in the parent process (86e2u72u2).
 *
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

  if (!lastGoodTag || !caproverUrl || !caproverAppToken) {
    logError('::error::LAST_GOOD_TAG, SRC_CAPROVER_URL, and SRC_CAPROVER_APP_TOKEN must all be set');
    exit(1);
    return;
  }

  try {
    const result = await rollbackImpl({ lastGoodTag, caproverUrl, caproverAppToken });
    if (!result.rolledBack) {
      logError(`::error::${result.reason} — manual recovery required`);
      exit(1);
      return;
    }
    logInfo(`Rolled back to ${lastGoodTag} (${result.lastGoodSha})`);
  } catch (err) {
    logError(`::error::${redactToken(err.message, caproverAppToken)}`);
    exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
