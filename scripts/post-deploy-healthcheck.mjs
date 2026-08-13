#!/usr/bin/env node
// Polls the deployed app's /health endpoint until it reports the expected build SHA
// (proving the rolling swap landed the new revision, not a stale one still mid-swap),
// or the retry window is exhausted. Exit code communicates the verdict to the CI job:
// 0 = healthy, 1 = never became healthy (caller is responsible for triggering rollback).

export const DEFAULT_RETRIES = 36;
export const DEFAULT_INTERVAL_MS = 10_000;

/**
 * Builds the /health URL from the app's base URL, tolerating a bare hostname.
 *
 * The 1Password vault stores hosts without a scheme — deploy.yml already prepends
 * "https://" to CapRover/url when calling the CapRover CLI. CapRover/app_url follows
 * that same convention, so the scheme is added here rather than in the vault, keeping
 * both URL fields consistent. Without this, fetch() gets a scheme-less string and
 * throws ERR_INVALID_URL on every single attempt.
 *
 * @param {string} appUrl - e.g. "app.example.com" or "https://app.example.com"
 * @returns {string} an absolute URL ending in /health
 */
export function buildHealthUrl(appUrl) {
  const withScheme = /^https?:\/\//i.test(appUrl) ? appUrl : `https://${appUrl}`;
  return `${withScheme.replace(/\/+$/, '')}/health`;
}

/**
 * True only for "this URL is unparseable" errors, which no amount of retrying fixes.
 * fetch() may surface it directly or nested as `cause`, depending on where the URL is
 * rejected, so check both levels.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isInvalidUrlError(err) {
  return err?.code === 'ERR_INVALID_URL' || err?.cause?.code === 'ERR_INVALID_URL';
}

/**
 * True when `candidate` is a later commit than `base` (i.e. `base` is an ancestor of
 * `candidate`) — meaning a newer deploy has already superseded the one this poll is
 * waiting on, rather than the app simply being unhealthy. Swallows any git failure
 * (unknown SHA, not a git repo, shallow clone missing history) as "can't prove it,"
 * since a race we can't confirm must still be treated as a real failure (86e2tmq3n AC2).
 *
 * @param {string} base
 * @param {string} candidate
 * @param {(cmd: string, args: string[]) => Promise<unknown>} runImpl
 * @returns {Promise<boolean>}
 */
async function isAncestor(base, candidate, runImpl) {
  try {
    await runImpl('git', ['merge-base', '--is-ancestor', base, candidate]);
    return true;
  } catch {
    return false;
  }
}

async function defaultRun(cmd, args) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  return promisify(execFile)(cmd, args);
}

/**
 * @param {object} opts
 * @param {string} opts.healthUrl - e.g. "https://app.example.com/health"
 * @param {string} opts.expectedBuild - the SHA the new revision should report
 * @param {number} [opts.retries]
 * @param {number} [opts.intervalMs]
 * @param {(url: string) => Promise<Response>} [opts.fetchImpl] - injectable for tests
 * @param {(ms: number) => Promise<void>} [opts.sleepImpl] - injectable for tests
 * @param {(cmd: string, args: string[]) => Promise<unknown>} [opts.runImpl] - injectable for tests; used only for the superseded-build ancestry check
 * @returns {Promise<{ healthy: boolean, lastBuild: string | null, attempts: number, superseded?: boolean }>}
 */
export async function pollHealth({
  healthUrl,
  expectedBuild,
  retries = DEFAULT_RETRIES,
  intervalMs = DEFAULT_INTERVAL_MS,
  fetchImpl = fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  runImpl = defaultRun,
}) {
  let lastBuild = null;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const res = await fetchImpl(healthUrl);
      const body = await res.json();
      lastBuild = typeof body.build === 'string' ? body.build : null;
      if (lastBuild === expectedBuild) {
        return { healthy: true, lastBuild, attempts: attempt };
      }
    } catch (err) {
      // A malformed URL can never succeed, so retrying it just burns the full budget
      // (6 minutes) before reporting "last observed build: none" — a misconfiguration
      // wearing the costume of an unhealthy app. Fail immediately with the real reason.
      //
      // Match ERR_INVALID_URL specifically, NOT `instanceof TypeError`: undici wraps
      // every fetch failure — including connection-refused during a rolling swap — in a
      // TypeError, so the broader check would abort on exactly the transient errors this
      // loop exists to ride out.
      if (isInvalidUrlError(err)) {
        throw new Error(`Cannot poll health endpoint "${healthUrl}": ${err.message}`, { cause: err });
      }
      // transient network/DNS error during a rolling swap — treat as "not yet healthy"
      // and keep polling rather than failing the whole check on one bad request.
    }

    if (attempt < retries) await sleepImpl(intervalMs);
  }

  // Two deploys landing within the poll window means the older commit's poller can
  // observe the *newer* commit's SHA as "last build" and misreport failure — which
  // would trigger a rollback of what is actually a healthy deploy (86e2tmq3n AC2). If
  // the last-observed build is a later commit than the one we expected, the app is
  // healthy on newer code, not unhealthy — treat it as superseded (pass/no-op).
  if (lastBuild && lastBuild !== expectedBuild && (await isAncestor(expectedBuild, lastBuild, runImpl))) {
    return { healthy: true, lastBuild, attempts: retries, superseded: true };
  }

  return { healthy: false, lastBuild, attempts: retries };
}

async function main() {
  const healthUrl = process.env.APP_URL ? buildHealthUrl(process.env.APP_URL) : undefined;
  const expectedBuild = process.env.EXPECTED_BUILD_SHA;

  if (!healthUrl) {
    console.error('::error::APP_URL is not set');
    process.exit(1);
  }
  if (!expectedBuild) {
    console.error('::error::EXPECTED_BUILD_SHA is not set');
    process.exit(1);
  }

  // pollHealth throws on a URL that can never work (vs. returning unhealthy for an app
  // that simply never came up). Both fail the job, but only this path names the real
  // cause instead of blaming the app for a misconfiguration.
  let result;
  try {
    result = await pollHealth({ healthUrl, expectedBuild });
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }

  if (!result.healthy) {
    console.error(
      `::error::Revision ${expectedBuild} never became healthy on ${healthUrl} within ` +
        `${result.attempts} attempts (last observed build: ${result.lastBuild ?? 'none'})`,
    );
    process.exit(1);
  }

  if (result.superseded) {
    console.log(
      `Revision ${expectedBuild} was superseded by a later healthy deploy (${result.lastBuild}) ` +
        `on ${healthUrl} before this check completed — treating as pass, not triggering rollback.`,
    );
    return;
  }

  console.log(`Revision ${expectedBuild} is healthy on ${healthUrl} (attempt ${result.attempts})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
