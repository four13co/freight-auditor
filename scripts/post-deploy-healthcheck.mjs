#!/usr/bin/env node
// Polls the deployed app's /health endpoint until it reports the expected build SHA
// (proving the rolling swap landed the new revision, not a stale one still mid-swap),
// or the retry window is exhausted. Exit code communicates the verdict to the CI job:
// 0 = healthy, 1 = never became healthy (caller is responsible for triggering rollback).

export const DEFAULT_RETRIES = 36;
export const DEFAULT_INTERVAL_MS = 10_000;

/**
 * @param {object} opts
 * @param {string} opts.healthUrl - e.g. "https://app.example.com/health"
 * @param {string} opts.expectedBuild - the SHA the new revision should report
 * @param {number} [opts.retries]
 * @param {number} [opts.intervalMs]
 * @param {(url: string) => Promise<Response>} [opts.fetchImpl] - injectable for tests
 * @param {(ms: number) => Promise<void>} [opts.sleepImpl] - injectable for tests
 * @returns {Promise<{ healthy: boolean, lastBuild: string | null, attempts: number }>}
 */
export async function pollHealth({
  healthUrl,
  expectedBuild,
  retries = DEFAULT_RETRIES,
  intervalMs = DEFAULT_INTERVAL_MS,
  fetchImpl = fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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
    } catch {
      // transient network/DNS error during a rolling swap — treat as "not yet healthy"
      // and keep polling rather than failing the whole check on one bad request.
    }

    if (attempt < retries) await sleepImpl(intervalMs);
  }

  return { healthy: false, lastBuild, attempts: retries };
}

async function main() {
  const healthUrl = process.env.APP_URL ? `${process.env.APP_URL.replace(/\/+$/, '')}/health` : undefined;
  const expectedBuild = process.env.EXPECTED_BUILD_SHA;

  if (!healthUrl) {
    console.error('::error::APP_URL is not set');
    process.exit(1);
  }
  if (!expectedBuild) {
    console.error('::error::EXPECTED_BUILD_SHA is not set');
    process.exit(1);
  }

  const result = await pollHealth({ healthUrl, expectedBuild });

  if (!result.healthy) {
    console.error(
      `::error::Revision ${expectedBuild} never became healthy on ${healthUrl} within ` +
        `${result.attempts} attempts (last observed build: ${result.lastBuild ?? 'none'})`,
    );
    process.exit(1);
  }

  console.log(`Revision ${expectedBuild} is healthy on ${healthUrl} (attempt ${result.attempts})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
