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
 * @param {string} opts.caproverAppName
 * @param {(cmd: string, args: string[]) => Promise<{ stdout: string }>} [opts.runImpl] - injectable for tests
 * @param {(url: string, appToken: string, appName: string) => Promise<{ status: string; raw: string }>} [opts.triggerBuildImpl] - injectable for tests
 * @returns {Promise<{ rolledBack: boolean, lastGoodSha: string | null, reason?: string }>}
 */
export async function rollbackToLastGood({
  lastGoodTag,
  caproverUrl,
  caproverAppToken,
  caproverAppName,
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
  // 86e2v1ccg: must build the frontend too, matching .github/workflows/deploy.yml's
  // main deploy step (86e2v07n3) — omitting this ships a rollback with no dashboard
  // UI at all, silently reintroducing "the dashboard has never been deployed" on
  // every rollback.
  await runImpl('npm', ['ci', '--prefix', 'web']);
  await runImpl('npm', ['--prefix', 'web', 'run', 'build']);
  // 86e2v1ccg: must also resolve the runtime .env, matching deploy.yml's "Resolve
  // runtime .env from 1Password" step (86e2v0acm) — checked out from the last-good
  // revision itself (not HEAD), same as everything else this rebuild uses.
  await runImpl('node', [
    '-e',
    `require('fs').writeFileSync('.env.tpl', require('fs').readFileSync('.env.template', 'utf8').split('\${OP_VAULT}').join(process.env.OP_VAULT))`,
  ]);
  await runImpl('op', ['inject', '-i', '.env.tpl', '-o', '.env']);
  await runImpl('rm', ['.env.tpl']);
  // Must match .github/workflows/deploy.yml's "Create deployment tarball" file list —
  // the tarball IS the entire Docker build context CapRover sees, and captain-definition
  // points at "./Dockerfile", so omitting anything here fails the rollback's server-side
  // build while `caprover deploy` still exits 0 (it confirms the upload, not the build) —
  // exactly like PR #33 fixed for the main deploy step (86e2tn08g), and the same class of
  // gap as 86e2v07n3/PR #70's web/dist omission.
  await runImpl('tar', [
    '-czf',
    'deploy.tar.gz',
    'Dockerfile',
    'captain-definition',
    'package.json',
    'package-lock.json',
    'dist/',
    'web/dist/',
    '.env',
  ]);
  await runImpl('rm', ['.env']);

  let result;
  try {
    result = await triggerBuildImpl(caproverUrl, caproverAppToken, caproverAppName);
  } catch (err) {
    throw new Error(redactToken(err.message, caproverAppToken));
  }
  if (result.status !== '100') {
    throw new Error(redactToken(`rollback deploy also failed (status=${result.status}): ${result.raw}`, caproverAppToken));
  }

  return { rolledBack: true, lastGoodSha };
}

// 86e2v1xtf: a hung subprocess here previously blocked the whole rollback step for
// 2h12m (run 31973373618) with no error and no output at all -- the step-level
// timeout deploy.yml now has (86e2v1qrn) bounds the job, but a command-level timeout
// here means execFile itself kills the child and rejects instead of relying solely on
// the runner to be torn down from outside. 9 minutes leaves headroom under the
// workflow step's own 10m timeout-minutes while still being far tighter than "forever".
const SUBPROCESS_TIMEOUT_MS = 9 * 60 * 1000;

// 86e2v2445: exported (was module-private) and given an optional third
// `timeoutMs` param so tests can drive the real execFile path directly --
// with the hardcoded 9-minute default there was no way to prove the timeout
// actually bounds a hang without a test that ran for 9 real minutes. Internal
// callers in this file never pass a third argument, so they keep using
// SUBPROCESS_TIMEOUT_MS exactly as before.
export async function defaultRun(cmd, args, timeoutMs = SUBPROCESS_TIMEOUT_MS) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  return promisify(execFile)(cmd, args, { timeout: timeoutMs });
}

// Uses the same `caprover deploy` CLI path PR #27 already moved the main deploy step to
// (.github/workflows/deploy.yml "Deploy to CapRover"), instead of the legacy
// `/api/v2/user/apps/webhooks/triggerbuild` webhook this previously hand-rolled via curl.
// That webhook is the same endpoint 86e25prau and 86e25uqxa both chased "Auth token
// corrupted" (status 1106) failures on for the main deploy step — rollback shared the
// defect only because it never got the CLI fix applied alongside it.
//
// 86e2v1xtf: root cause of the 2h12m hang in run 31973373618. This call omitted
// --appName, and the CapRover CLI's `deploy` command treats a missing app name as an
// interactive prompt ("select the app name you want to deploy to" — confirmed by
// reading caprover's own commands/deploy.js: the `app` option has no `when: false` and
// is only skipped when a value is supplied via flag or CAPROVER_APP env). On a non-TTY
// CI runner that prompt never resolves and the process just sits there producing no
// output and no error -- exactly what run 31973373618's log showed. deploy.yml's own
// working "Deploy to CapRover" step already passes --appName; this call never did.
export async function defaultTriggerBuild(caproverUrl, caproverAppToken, caproverAppName) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    const { stdout } = await run(
      'caprover',
      [
        'deploy',
        '--caproverUrl',
        `https://${caproverUrl}`,
        '--appToken',
        caproverAppToken,
        '--appName',
        caproverAppName,
        '--tarFile',
        'deploy.tar.gz',
      ],
      { timeout: SUBPROCESS_TIMEOUT_MS },
    );
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
  const caproverAppName = env.SRC_CAPROVER_APP_NAME;

  if (!lastGoodTag || !caproverUrl || !caproverAppToken || !caproverAppName) {
    logError('::error::LAST_GOOD_TAG, SRC_CAPROVER_URL, SRC_CAPROVER_APP_TOKEN, and SRC_CAPROVER_APP_NAME must all be set');
    exit(1);
    return;
  }

  try {
    const result = await rollbackImpl({ lastGoodTag, caproverUrl, caproverAppToken, caproverAppName });
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
